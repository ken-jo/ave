# Plugin HostApi as a versioned protocol

Plugin names such as `mail`, `portal`, `assistant` and `ave-plugin-repo` in this
record are generic stand-ins for plugins that are no longer part of this project.

The code packages described here are called extensions in user-facing copy.

**Released contract.** Released hosts serve protocol `"3"`, introduced by
0.14.0 on the `ave/*` wire. Published plugins continue to declare
`requires.hostProtocol: "3"` and `requires.minAppVersion: "0.14.0"`.

**Unreleased contract.** This development build serves protocol `"4"` only
(`HOST_PROTOCOL_VERSIONS_SERVED`, `src/plugins/isolation/host-api-wire.ts`).
It requires host-generated state on plugin loopback OAuth callbacks (§3.3.1).
The app release version is selected by release preparation, independently of the
protocol major. No first published app version is recorded for protocol 4;
`requires.hostProtocol` negotiation determines support, and released protocol-3
hosts reject protocol-4 packages before activation regardless of `minAppVersion`.
Its schema/client and wire fixtures live under `schemas/plugin-host-protocol/4/`
and `src/plugins/isolation/__tests__/fixtures/host-protocol/4/`.

The existing unreleased-candidate convention (§6.1) stores the new schema under
`web/public/schemas/plugin-host-protocol/4/v0.14.1/`, with
`publishedTag: null`. That version segment identifies the open schema candidate,
not an announcement that 0.14.1 has shipped protocol 4. Historical protocol-3
schema copies remain unchanged. Publish protocol-4 plugin replacements only with
the coordinated app release; use its actual release tag and minimum version.
Numbers in the historical plans below describe those steps, not this candidate.

Status: design, decided; the wire step (§9.4) is implemented on `main`; the Lease step
(§9.1, §4.1, §9.5) was amended on 2026-09-27 with decisions 8-26 (§13), in two rounds
of independent review, and shipped as v0.12.0; the Publication step has its
implementation plan in §9.7 (2026-09-28, decisions 27-47) and targets 0.13.0; Admission
(§9.8, decisions 48-62) and the move to protocol `3` on the `ave/*` wire target 0.14.0. It follows
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
step), the official repository at `6a4d3b3`, `ave-plugin-portal` at `2f17388` and
`ave-plugin-repo` at `d71fb95`; a citation in those sections without a repository name is
ave at `f1a8d191e`. The Publication plan (§9.7, and the §2.1, §6.1, §6.2, §10.2
and §13 lines it amends) cites ave at `c73f59580` (main, 2026-09-28) and the
official repository at `6a4d3b3`.

---

## 0. What is already true, and what this document changes

The process boundary exists. It is not the open question.

- `OUT_OF_PROCESS_PLUGIN_IDS` routes `assistant`, `mail`, `local-indexer`,
  `meeting` and `portal` into a confined child process
  (`src/plugins/isolation/out-of-process-plugins.ts:856-858`; commit `72b8c3b50`,
  2026-08-26, "admit portal out-of-process — 5/5"). The set is frozen and read by no
  configuration, manifest field or environment variable; a plugin moves only through a
  reviewed commit (`out-of-process-plugins.ts:7-12`). `assistant` is being retired — its
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
| 5 | Host isolates and sandboxes at the boundary | **Yes on macOS/Linux; filesystem+network against the host only on Windows** | ASRT (`architecture.md:1013-1020`). The Windows process-confinement gap is decided in decision 3 (§13): admission does not depend on it, and a `process` entry is refused on Windows (§2.2, §7.3). On Windows plugins are not isolated from each other: every confined process shares one sandbox account (decision 64). |
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

`process.command` follows the Agent Plugins stdio rule with one Ave narrowing: it is a
`./`-relative or `${PLUGIN_ROOT}/`-anchored path inside the plugin root — never a bare
executable name, because a marketplace plugin gets no `PATH` search (§7.3; decision 32,
§9.7) — with `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expanded in `args` and `env` and both
variables set in the child environment
([Agent Plugins §9.1](https://agent-plugins.org/specification)). `PLUGIN_DATA` is
`pluginDataDir` (`public-contract.ts:2153`). The schema branch, the hardening rules and
the spawn are the P3 slice of §9.7. A `process` entry is admitted only for an
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
| Windows | srt-win, one shared `srt-sandbox` account; deny-only grant mode; holder-PID ACL grants on a plugin child's own directories, a delegated worker's, a bundled hook's and an MCP stdio server's, each for that process's lifetime; the `entry` child runs under `cmd.exe` and speaks over an authenticated loopback connection, and a worker, hook or MCP stdio server runs through the same connection as a stdio relay (§2.3) | filesystem, network, against the host. **No process confinement; no isolation between plugins** (decision 64) | `architecture.md:1018-1020`, `confined-child.ts:43-46`, `out-of-process-plugin.ts:970` |

The child is confined exactly as much as the host's workers are:
`features.pluginWorkerConfinement` decides for plugin workers, plugin children, plugin
script hooks and MCP stdio servers alike; `features.osToolSandbox` decides only for the
host's shells (the bash and PowerShell tools and the workspace terminal) and never for a
child (split in 0.14.1; settings load derives `pluginWorkerConfinement` from the stored
`osToolSandbox` whenever a file lacks the boolean, so an existing opt-in stays on for both). The environment overrides split
the same way: `AVE_SANDBOX_ENABLED=1` forces the shell scope only, and
`AVE_PLUGIN_WORKER_CONFINEMENT=1` forces the worker scope. When worker confinement is off
the child is spawned unwrapped and nothing marks it confined, so the reviewer grants no
sandbox-based relaxation (`out-of-process-plugin.ts:13-21`, `sandbox-gate.ts:20`,
`isPluginWorkerConfinementActive` in `asrt-sandbox.ts`).
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

When `features.pluginWorkerConfinement` is off nothing is enforced and nothing is marked confined
(as above); the block is still validated, reviewed and consented so an install is not
re-reviewed when the sandbox is turned on, and the Doctor names the plugin as unconfined.

This closes the AGENTS.md "no plugin-specific branches in the host" violation without
weakening the envelope. `local-indexer` ships exactly the four declarations above and
no other plugin gains a grant: `meeting`'s managed FFmpeg lives under its data
directory (official repository at `6a4d3b3`,
`plugins/meeting/source/src/ffmpegRuntime.ts:350-386`), `portal`'s native worker asks
for empty read and write sets (`ave-plugin-portal` at `2f17388`, `src/nativeAdClient.ts:655-663`:
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
(`stdio-framing.ts:1-17` on `d036d87c6`), shared with
`src/mcp/experimental/stdio-server-loop.ts`. The host's
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

**Windows with the OS sandbox on: one loopback connection instead of the pipes.** ASRT
0.0.76's `srt-win exec` relays the target's stdout but no stdin (measured 2026-10-10:
`echo hi | srt-win exec -- cmd /c more` prints nothing), so on that one path the reference
runtime does not use its pipes for the protocol (`child-loopback-link.ts`). The child
listens on `127.0.0.1:0` and writes one line to stdout — `Ave-CHILD-LISTEN <port> <nonce>`,
the nonce 32 fresh random bytes that never cross the socket. The host reads that line from
the stdout it owns and connects from `127.0.0.1`; then both ends prove they hold the
nonce, each proof bound to that one TCP connection by both ends' addresses and ports,
which each side reads from its own socket (IPv4-mapped addresses unmapped):

- host → child: `HMAC-SHA256(nonce, "ave-loopback host <hostAddr> <hostPort> <childAddr> <childPort>")`, hex, newline;
- child → host: `HMAC-SHA256(nonce, "ave-loopback child <childAddr> <childPort> <hostAddr> <hostPort>")`, hex, newline.

Every 127/8 address reaches a `127.0.0.1` listener (measured on Windows: a client bound to
`127.0.0.2` connected), so the child drops a peer whose address is not `127.0.0.1` before
reading a byte, and the addresses are in the proofs as well. The child checks the host's
proof against the remote address and port it sees before answering, and
the host treats the connection as the child's only after the child's proof checks; only
then are frames sent, exactly as over the pipes. A peer that fails — a wrong or replayed
proof, more than a proof's length, silence past the handshake time, an error — is dropped
and the child keeps listening, for at most 8 failed peers (4 handshakes at once) within the
accept time; then, or with no host in time, the child ends non-zero. A connection beyond
the 4 is dropped at once, the host's own included, so the host connects once more, 0.5 s
later and within its time limit, if the child closed its first connection unanswered.
Once the host is in,
the listener closes and any peer still in its handshake is dropped. The channel's end is
the child's end: the child exits when the connection closes, and the host ends the process
when it does. srt-win's network filter refuses the sandbox account's outbound connects
outside the proxy ports — loopback included, so one sandboxed process cannot dial
another's listener (measured: `EACCES`) and the child cannot dial the host; the host's
inbound connect to the child's listener is admitted (measured), the shape a Windows
worker's TCP control channel already has. A `process` entry never runs on Windows (§2.2),
so this path serves the reference runtime only; macOS, Linux and Windows with the sandbox
off keep stdio.

**The same channel as a stdio relay, for programs the host does not write.** A bundled
hook reads its payload on stdin, an MCP stdio server its requests, and a plugin worker its
host's liveness (stdin ends only when the host is gone); none of them can be taught the
channel above. Under srt-win each runs through the reference runtime in relay mode
(`--ave-child-transport=relay`, `child-loopback-link.ts`, `confined-child.ts`
`windowsStdio: "relay"`): the same `cmd.exe` launch, the same announce and handshake, and
then one request line — the program, its arguments, its environment, its working directory, as
JSON, at most 1 MiB, with unknown fields refused. The relay starts the program with a real
stdin pipe and copies the channel into it; the program inherits the relay's stdout and
stderr, which srt-win carries to the host; the relay exits with the program's exit code
(127 if it could not start, with the reason on stderr). A batch file is refused before
anything starts, by extension (`.cmd`/`.bat`, any case) and for a bare name only a batch
file on `PATH` answers (`npx` with no `npx.exe`): Node will not spawn one without a shell
(measured: `spawn EINVAL`), and its only shell is `cmd.exe`, which would parse the
program's third-party arguments — the one thing the relay exists to prevent. The refusal
names the file and says to name the executable it starts (for `npx`, `node.exe` with npm's
`npx-cli.js`). The program's input ends when the
host ends it or when the channel goes away, so a worker still reads its end as its host
leaving. Relay and program run inside the one wrap — the same account, restricted token,
job object, filesystem and network fence — so the relay adds a hop, not a privilege.
Because the request travels over the authenticated channel, nothing third-party meets
`cmd.exe`: the line carries only the host's own executable, its entry path, Node's flags
and the transport argument. Two things are set for every relayed program: the environment
leaves to srt-win what srt-win itself sets (`PATH`, `PATHEXT`, the proxy and CA overlay,
`GIT_CONFIG_*`, `USERNAME`; `TMPDIR` and `ELECTRON_RUN_AS_NODE` are dropped), and
`NODE_OPTIONS` leads with `--preserve-symlinks --preserve-symlinks-main`, without which no
Node program under the user profile loads at all (measured: `EPERM: lstat` on the profile
directory above `<AVE_HOME>`; §9.8 A2). srt-win's PowerShell inner shell, its default, is
no longer used by any sandboxed spawn: it gives the target no stdin, no environment and
not even its exit code (measured: a target exiting 7 reported 1), so `spawnConfinedChild`
refuses a Windows sandboxed spawn that names neither the relay nor `cmd.exe`.

### 2.4 Identity binding

The host spawns the process and owns both ends of its pipes. Identity is therefore the
connection: the host attributes every inbound message to the `pluginId` it spawned that
connection for, and the plugin never names itself.

On the Windows loopback channel (§2.3) identity rests on the nonce the spawned child wrote
to the stdout only the host reads, and on the handshake's proofs being bound to the one
connection they cross. What that guarantees, against a local peer that does not hold the
nonce:

- It cannot be the host to the child: it has no proof for its own connection, and the
  host's proof, if it took the host's connection and replayed it, names that connection's
  addresses and ports, not its own — and a peer on another 127/8 address that took the
  host's port number is dropped for its address before it is read. The child drops it and
  keeps waiting for the host.
- It cannot be the child to the host: if the host's connection reached it instead of the
  child (it bound the announced port first, or after the child's listener closed), it
  cannot answer with the child's proof, so the host sends nothing — no frame, no relay
  request, no environment, no program input — and the load fails. A second bind of the
  child's port is refused on Windows even to the same account (measured, `SO_REUSEADDR`:
  `WSAEACCES`), so with the child alive the host's connect reaches the child's listener.
- It can delay the load or end it: up to 8 failed peers within the accept time, and the
  child gives up; holding the 4 handshake slots past the host's second connect also ends
  it. That is the bound; a local process that can connect to loopback can deny
  a plugin its start, and only that.

A process that holds the nonce besides the two ends could only have read it from the
child's memory or the host's; the child's memory is open to every process of the same
account, which is decision 64's accepted risk, and such a process could drive the child's
own socket anyway. For that reason the host does not also check that the connected
socket's owner is the spawned child (`GetExtendedTcpTable`): the owner is not the process
the host spawned but three hops below it, across the account boundary (measured: the host
spawns `srt-win.exe` as the user, which starts `srt-win.exe` as `srt-sandbox`, then
`cmd.exe`, then the child, which owns the socket), so the check would have to trust a
process tree srt-win builds, and it would not exclude the one peer the proofs leave in. A child whose process is gone by the time the
handshake finishes is not served: the host reads its exit from the spawn on, and checks
its exit status once more after connecting. The relay's channel is bound the same way,
and a relayed program is the host's own spawn: the request that names it is sent only after
the child's proof checks.

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
- **Invocation token (decision 63).** Every `tools/call` the host sends carries
  `_meta["ave/invocation"]`, an opaque token that is fresh per call. A child carries
  the same token in `params._meta["ave/invocation"]` of each `ave/host/*` request it
  makes for that call. The host runs the request in the invocation's own context: its
  effect gate (foreground approval, headless deny), its effect ledger and its origin,
  exactly as an in-process handler's hostApi call inherits them.
  - The token stays valid after the call settles, for the life of the connection. This
    covers work the handler scheduled and left running after it returned. In-process,
    a timer keeps the invocation's frame, so a headless invocation's late write is
    denied and a foreground one's still asks the user. The host keeps each settled
    call's context until the connection closes, up to 1024 settled calls per connection
    (oldest dropped first; calls in flight are never dropped).
    At most 64 tool calls may be live on one connection. The host rejects an excess
    call before capturing its context or sending it; a hung child cannot accumulate
    unbounded live snapshots. The two tables retain at most 1088 snapshots in total.
    This is a reference-count bound, not a byte limit on the stores each snapshot holds.
    Close, timeout, fault and observed exit release the tables before fallible child
    termination or subscription teardown; retirement for restart uses that same close.
    Session teardown closes the transport before releasing host watchers, and `stop`
    reaches teardown even if a watcher disposer throws.
    Teardown releases host watchers and calls the owner's close handler in `finally`
    even when transport subscription cleanup throws.
    A transport deadline closes the connection. The executor ceiling only detaches
    the caller when the handler cannot cancel; that call remains live until its child
    reply or connection close, under the same 64-call admission bound.
    A child that never replies keeps its slots after caller detachment. The admission
    error names the plugin and instructs the caller to restart it to clear unresolved
    calls; detachment alone neither cancels that child work nor releases its context.
  - A request naming a token the connection never issued, or no longer holds, is
    refused with `argument-marshalling-rejected`. It never runs with less gating than
    its invocation had.
  - A request without the token runs outside any invocation, which is where an
    in-process plugin's work outside a tool call runs (lifecycle hooks, timers set at
    start). The host sets that context explicitly. It does not inherit the context of
    whatever delivered the frame, which is the context the child was spawned in, and
    that context is a finished tool call's when the call restarted the plugin
    (`config.set`).
  - Leaving the token out is the child's choice, so a child can run a gated write
    ungated by omitting it. The host cannot tell such a write from honest background
    work, so it does not refuse it. When a gated write arrives without a token while a
    `tools/call` is in flight on the same connection, the host logs a warning
    (`host-api-dispatcher`) naming the plugin, the path and the in-flight count.
    Mutating `hostFetch` methods are included even though their gate is inline;
    GET, HEAD and OPTIONS do not emit this warning.
    Only the first qualifying write per path per connection emits this warning;
    repeated writes neither emit more lines nor retain argument values.
  - The outside-invocation context is captured during boot, before invocation scopes
    are entered. Lazy evaluation inside an effect-gate or invocation-origin frame is
    refused, including the origin-only frame of a trusted app-only tool. Evaluation
    inside an unrelated async-context store is not a root capture and is unsupported;
    callers must load the module from boot's neutral context.
  - The reference child runtime (`plugin-child-runtime.ts`) carries the token for every
    handler. A child written in another language that omits it gets no invocation for
    its hostApi calls.
    Existing children may omit this optional metadata, and their own metadata keys
    remain ignored. A child using `ave/invocation` must echo the host's opaque value
    unchanged; substituting its own correlation id or re-encoding the value is refused.

Additive changes (new optional field, new method, new capability) do not bump the host
protocol version. Renaming, removing, changing a type, or changing a default does.

### 3.3.1 Host-validated loopback OAuth

`authRedirect.open()` returns `{ handle, redirectUri, state }`. The host mints a
fresh 256-bit cryptographic random state, encoded as base64url, for each listener.
A plugin sends that exact value in its authorization request. It must also use
PKCE with `S256`: public clients require PKCE under
[RFC 9700 §2.1.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1),
and missing or incorrect state validation enables the PKCE downgrade attack in
[§4.8](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.8).

Only a GET to the exact callback path with one matching state can complete the
catcher. Duplicate parameters and malformed queries are refused. State comparison
uses fixed-size SHA-256 digests and a timing-safe comparison, including unequal
input lengths. Wrong or missing state receives a 4xx and leaves all waiters pending;
rejection logs contain the owner and a fixed reason, never the query, code or state.
The first state-validated callback consumes the state, even if the provider
parameters have no usable code. Replays are refused; subsequent `wait()` calls
read the cached result until close. The host authenticates correlation; the plugin
rejects missing codes or conflicting success/error fields before token exchange. A matching callback carrying
`error` / `error_description` is delivered with those fields and shows the failure
page; the plugin checks `error` before exchanging any code. Each `wait()` starts its own timeout; expiry closes the catcher and rejects all
pending waiters. Explicit close does the same. After close, cached results are
unavailable and the next `open()` mints a new state.

This changes an existing method's required behavior: a plugin-generated state
that protocol 3 accepted now fails. Under §3.2 and §3.3 this is **protocol 4**,
not an optional capability on 3. A capability list names methods and does not
select different state semantics for the same method. No state-free branch or
compatibility shim is served. An unreleased protocol has no numeric app-version
floor; negotiation of `requires.hostProtocol` is authoritative. Candidate schema
version segments do not imply released support. Release preparation records the
first published app version when the protocol ships.
The 2026-10-27 owner decision authorizes preparing this boundary now; it does not declare replacement plugin packages published.
The replacement testing and publication gates in §9.3 and §9.5 still apply before
an app release is published: test candidates against the boundary commit, vendor
the contract from its app release tag, and publish replacement plugin packages
before publishing the app draft. See the [author migration and PKCE example](../guides/plugin-development.md#loopback-oauth-with-pkce).

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
category. Protocol `2` added exactly these four codes, and protocol `3` keeps them; each is a thrown error on the
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
| `storage.resolve` (:1078) | local | child-local | none; pure lexical join under the plugin's host-only storage directory (`<plugin root>/storage`, beside `data/`; decision 65) with shared traversal rejection (blueprint §3.1) | none |
| `storage.read/readText/readJson/list/exists` (:1080-1098) | req | plain-json → plain-json / `read` encoded (base64) | operates in the host-only storage directory no confined child can write (decision 65); host containment (`plugin-storage-containment.ts`) kept as defence in depth; read effect recorded | 16 MiB cap (`host-api-wire.ts:471`) |
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
| `spawnWorker` (:1410) | sub | plain-json → handle | worker envelope must be within the plugin's envelope (`host-api-dispatcher.ts:1160-1161`); command is a host-spawned process | `{ handleId, socketPath, pid }` cross; the internal handle id derives from the existing RPC id and is registered before send; stdout/stderr/exit notifications use bounded pre-listener replay, drained-output completion and explicit overflow failure as defined in the blueprint §3.2 (`host-api-wire.ts:1652-1666`) |
| `openAuthWindow` (:1437) | UI | plain-json → plain-json | host-owned BrowserWindow, cookie host allow-list (`auth-window-service.ts:10-16`) | with `retainCookies` the values stay in the partition; the reply carries names or the final URL only |
| `authRedirect.open/wait/close` (:1474-1484) | req | plain-json | host loopback listener, one per plugin | host-issued state required before callback delivery (§3.3.1) |
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
  `portal` (`ave-plugin-portal` at `2f17388`: the reader is bound at
  `src/sessionVault.ts:35-40` and invoked at `:65`) to drive a browser context whose
  requests the host cannot issue, **and** to read the partition's `user_id` and
  `refresh_token` cookies for the service's token refresh, which it then sends as a JSON
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
holds only the LLM class); `getAuthPartitionCookies` for `portal`;
`resolveApiKey({ exposure: "raw" })` under `secrets:raw-api-key` with the receipt
evidence of §4.1.6 (no official plugin declares it); `storage.readEncrypted` plaintext
of what the plugin wrote (`mail`'s token store uses `writeEncrypted`/`readEncrypted`,
official repository at `6a4d3b3`, `plugins/mail/source/src/auth/token-store.ts:73-77`;
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

- **No lease:** the plugin's own headers pass as today. `mail`'s OAuth `Bearer`
  (official repository at `6a4d3b3`, `plugins/mail/source/src/email/graphClient.ts:82`,
  `src/calendar/calendarClient.ts:35`, through `src/http/runtime-http.ts:102-107`),
  `portal`'s cookie-authenticated calls (`ave-plugin-portal` at `2f17388`,
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
  `mail`'s token store is encrypted plugin storage (`writeEncrypted`,
  `plugins/mail/source/src/auth/token-store.ts:73-77`), a different category that
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
| `mail` | obtains its own OAuth token and sends it through the host-bound transport (`:82`, `:35`, `runtime-http.ts:102-107`); `getSecret` appears only as an interface member (`src/hostPlugin.ts:84`) | no-lease requests; unchanged |
| `portal` (`2f17388`) | bound transport (`src/hostTransport.ts:45-52`); cookie/refresh export as in §4.1 | unchanged by Lease; rebuilt and republished for `hostProtocol: "2"` (the 0.12.0 wave; `"3"` since 0.14.0, see Current contract) |
| `git` (`d71fb95`) | in process; direct `fetch` with cookie and GitHub auth (`src/hostPlugin.ts:797-806`) and with plugin LLM keys (`:920-932`); `~` expansion of `dataDirectory` (`:824-834`) written under (`:1140`) | rebuilt and republished for `hostProtocol: "2"` under the generic rule (the 0.12.0 wave; `"3"` since 0.14.0); the direct-fetch and external-directory migrations are Admission prerequisites (§9.1, §9.2 item 7), not Lease work |
| `assistant`, `hello-world`, `templates/plugin` | no credential surface | republished for `hostProtocol: "2"` (the 0.12.0 wave; `"3"` since 0.14.0; assistant only if it is not already revoked by the alerts release, §9.5) |

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
`https://ave.agent-connector.ai/schemas/plugin-host-protocol/<protocol>/<app tag>/protocol.schema.json`,
served from `web/public/schemas/` and added by the release change that bumps the app version —
the site deploys on every `web/**` merge, so the copy must travel with the tag, not ahead
of it (decision 6). The `$id` is that tagged URL and is never reassigned: an additive
change within protocol `1` (§3.3) ships in a new app tag and therefore under a new `$id`
(Agent Plugins conformance, "Never reassign a published canonical schema identifier",
[checklist](https://agent-plugins.org/client-implementers/conformance)). The site
publishes only protocols the host serves (protocol 3, under the Ave origin); the
schemas of retired protocols 1 and 2 are no longer published.
`.../plugin-host-protocol/<protocol>/protocol.schema.json` is a documented moving alias to the
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
  §9.5 imposes; regenerating the candidate is permitted **only while no tag carries its
  bytes** — once the tag exists the canonical file is frozen on `main` until the next
  version bump opens the next candidate, whatever `publishedTag` says, and that bump is
  the first change after the tag (`docs/development/release-process.md`, "Between
  releases"; §9.7, "The mirror freeze") — so a protocol change that must ship after the
  freeze ships as the next candidate. **(E2, the post-publication runbook step)** the `web`-only PR merged after
  the app draft is published (§9.5 step 6) sets the entry's `publishedTag` and, in the
  same commit, sets the protocol's `alias` to the **newest published copy of that
  protocol** — the promoted copy if it is the newest, otherwise the alias stays where it
  is — which is the explicit promotion mechanism; a candidate's copy cannot become the
  alias by deploying. The check enforces the newest-published rule whether or not the
  protocol has an open candidate, so two promotions of one protocol commute in either
  order (`scripts/lib/plugin-host-protocol-mirror.mjs`; §9.7 M1, decision 39). The v0.11.0 release does
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
| Protocol-level TS client (JSON-RPC stubs) | host build | the committed protocol schema (§9.7 P1) | `schemas/plugin-host-protocol/<version>/protocol-client.ts`, emitted beside the schema, dependency-free, carrying the protocol version and no app version, gated by `check:plugin-host-protocol-client` and vendored with the schema; used by the conformance tests and by authors who want to speak the protocol from JS without the reference runtime |
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
| `portal` (`2f17388`) | `tools/contract.mjs` | release tag required (`tools/contract.mjs:16`) | **exactly two files**: `public-contract.ts` and `plugin-manifest.schema.json` (`tools/contract.mjs:19-20`; the exact count is enforced at `:28-29`) | offline check on every run; upstream verify on every non-PR run (push, schedule, dispatch) and on a PR only when it changes `contract/` (`.github/workflows/ci.yml:70-85`) |
| `git` (`d71fb95`) | `tools/vendor.mjs` | release tag required (`:17-18`, `:107-109`) | per `sources.json` | PRs that touch `contract/**`, `tools/vendor.mjs` or the workflow, plus schedule and manual (`.github/workflows/contract-verify.yml:3-11`, `:26`) |

Advanced into Lease: the protocol schema becomes a vendored artifact **now** (the
`requires.hostProtocol: "2"` pin needs the bytes it pins), so `portal`'s two-file inventory
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

**Catalog format (decision 24, superseded 2026-10-14).** A repository has one index,
`marketplace.json`, whose format version is inside it as `schemaVersion: 2`; version
objects carry `hostProtocol` and `authority.sandbox`, and descriptors carry
`schemaVersion: 2`. The app reads that file only (`MARKETPLACE_INDEX_FILE`,
`src/marketplace/catalog/types.ts`) and refuses any other `schemaVersion` with a message
naming it (`src/marketplace/catalog/validate.ts`, `CATALOG_SCHEMA_VERSION`). Apps before
0.12.0 refuse the file and keep their last pin; already-installed plugins on them run
unchanged.

> Historical: 0.12.0–0.13.x read the format-2 index from `marketplace.2.json` while a frozen format-1 `marketplace.json` kept serving apps ≤ 0.11; that split is retired.

Acceptance: X offers only protocol-2 versions from the official source and shows the
new `local-indexer` sandbox authority in review.

| App | Installed artifact | Result |
|---|---|---|
| ≤ 0.11 | old (no declaration or `"1"`, `minAppVersion` ≤ app) | runs, unchanged |
| ≤ 0.11 | new (`"2"`, `minAppVersion` X) | never listed for it: an old app refuses the `schemaVersion: 2` index outright and keeps its last pin (decision 24); a direct or offline install is refused at load with `incompatible-app-version` ("update the app"); on an app whose manifest schema predates the field the closed `requires` object refuses it with a schema error. Never activated |
| X | old, declares nothing | **refused before activation**, `incompatible-host-protocol`, plugin-status "update required", with the update path: the catalog's newest eligible version if the source publishes one, otherwise the plugin's own repository named in the receipt |
| X | old, declares `"1"` | same refusal; the message names the served version |
| X | new | runs |
| X → ≤ 0.11 downgrade | new | refused with `incompatible-app-version`; the downgraded app refuses the current index (decision 24) and keeps its last pin, so the user reinstalls a pre-X version from that pin or the plugin's own repository. A downgrade does not reverse a plugin update and does not promise that plugin data written by the new version is readable by the old one; the receipt of the last compatible version is kept so the Doctor can name it |
| any | offline, update-disabled, custom source, direct install, local development, managed/policy | the same generic rule with no exception. A managed required install is brought to the source's candidate every boot (`boot-installs/run.ts:4-8`), so it self-heals once the managed source publishes a `"2"` artifact; until then it is refused like any other |

**Cost, stated.** Every installed code plugin that was built before X — third-party
and local development installs included — stops loading on X until it is rebuilt
against the contract at tag X and republished with `requires.hostProtocol: "2"` and
`requires.minAppVersion: X`. All eight reviewed sources omit the field today
(`plugins/{meeting,local-indexer,mail,assistant,hello-world}/source/plugin.json`,
`templates/plugin/plugin.json` in the official repository; `portal` `plugin.json:1864`;
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
that is published and not revoked at X — `meeting`, `local-indexer`, `mail`,
`hello-world`, `portal`, `git`; `assistant` only if the alerts release has not
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
| Resource exhaustion: a plugin process consumes memory/CPU | Linux: per-plugin cgroup limits are not wired to the spawn path. macOS: `RLIMIT` in the wrapper is deferred (decision 7); Windows: Job Objects are not available through srt-win today. Until then the control is crash containment: the host survives, the plugin is marked degraded. |
| A plugin process outlives the host | child exits on stdin end (`plugin-child-main.ts:319-326`); `managed-child-processes.ts` tracks and kills process groups on app quit; a `process`-entry plugin must pass the stdin-close conformance check (§10). Residual: a hard host crash on Windows leaves the child to notice a closed pipe on its next write. |
| Arbitrary executable via `process` entry | a pinned release or archive artifact only (§2.1); a wrap whose published `confines` includes `process` (never srt-win); refused when the sandbox is off; the command must be inside the plugin root (Agent Plugins rule); no `PATH` search for a marketplace plugin. |
| Envelope widening via the manifest `sandbox` block | closed `hostDirectory` allow-list; `userChosenDirectory` requires a user-set absolute path; deny-floor piercing requires install-time approval (§2.2). |
| Windows: no process confinement | unchanged from `architecture.md:1018-1020`; admission does not depend on it (decision 3); a `process` entry is refused on Windows because srt-win is a wrap that does not confine processes (§2.2); the Doctor names the confinement each plugin runs under. |
| Windows: one sandbox identity for every plugin | none by design (decision 64): every confined process — each plugin's child, workers, and the host's own tools — runs as the one `srt-sandbox` account, so a plugin child's or worker's grant is visible to every confined process while held (measured: two grants held at once, each plugin read and wrote the other's data) and no deny can separate plugins; `denyPluginsRoot` is refused there. Inter-plugin isolation is a macOS and Linux property only (§9.8 A2). |
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
  storage in chunks. No chunked body streaming in protocol `1` or `2`. A **download**
  above the cap is fetched as HTTP `Range` slices, each within it, and appended to a
  file under the plugin's data directory. `range` is an ordinary request header the
  host carries onto every gated hop, a cross-origin redirect included. What a hop does
  drop is decided in `runHostFetchHops` (`src/main/host-fetch-guard.ts`) on two
  independent rules. A cross-origin hop drops `CREDENTIAL_HEADERS` (`authorization`,
  `proxy-authorization`, `cookie`, `api-key`, `x-api-key`,
  `ocp-apim-subscription-key`) and `anthropic-version`. Separately, any 303 hop, and
  any 301/302 hop after a POST, same-origin or not, turns the request into a bodyless
  GET and drops `content-type` and `content-length` with the body. A `206` comes back with its
  `content-range`. A server that ignores `Range` answers `200` whole, which the cap
  refuses with `payload-too-large` before allocating it, and the refused body is
  cancelled rather than left open. Pinned by
  `host-api-service-members.test.ts` (a body over the cap refused whole, then carried
  intact in slices across the real child encoder and host decoder) and
  `host-fetch-guard.test.ts` (`range` kept across a cross-origin hop). `meeting`'s
  managed FFmpeg download (27-80 MB archives) is the consumer.
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
| Lease (protocol `2`, app release X = 0.12.0; decisions 8-26) | credential lease: `bearer()` removed, `ResolveApiKeyResult` union, `HostFetchInit.auth` forwarded to the one factory path, host lease registry with linearised issuance and epoch fencing, audience and scheme binding by normalized source, credential-header clearing per hop including `api-key`, cookie composition, the four closed error codes, raw exposure under `secrets:raw-api-key` with receipt-bound consent, the operation rule that refuses host-provider-key export through `getSecret` and the removal of the official plugins' fallbacks (§4.1); catalog format 2 (§6.4); `sandbox` manifest block through schema, runtime, marketplace authority, descriptor/index, review, receipts and the re-vendored checker, replacing `PLUGIN_ENVELOPE_GRANTS` with the global exclusions preserved (§2.2, §6.3); protocol-aware catalog selection and the pre-activation refusal of undeclared or unserved protocols on both arms (§3.2, §6.4); dispatcher budgets (§7.4); `FormData` serialisation in the reference runtime and the 15 MiB effective STT body (§8); schema regeneration at the final version and the web mirror (§6.1); the protocol schema joins the vendored set (§6.3) | host: the gates of §9.6 per slice, then once at publication; plugins: `meeting` both STT paths in host-key and plugin-key modes through the real child encoder with abort, release and revoke; `local-indexer` startup, warm-up, scan, query outside a scan, caption, key switch and restart through the real broker with the worker holding tokens only and a synthetic marker proving no shared key leaves main on argv, env or any normal frame, lease counts returning to baseline; lease-failure paths of both plugins proven not to reach `getSecret`, a raw resolve or a socket; old `meeting`/`local-indexer` bundles refused before activation on X; the packaged upgrade matrix of §6.4 including downgrade and offline; `mail`, `portal`, plugin-key STT/indexer and the FFmpeg download unchanged; measured budgets (§7.4) | **announced boundary, not a runtime flag-day**: every code plugin republishes with `requires.hostProtocol: "2"` and `minAppVersion` X; `resolveApiKey` callers (`meeting`, `local-indexer`) migrate to the lease; `local-indexer` manifest carries its four `sandbox` declarations; publication order in §9.5 |
| Publication (app release 0.13.0; §9.7, decisions 27-47) | TS protocol client vendored with the contract (§6.2, §6.3); validate CLI; `process` entry runtime under a process-confining sandbox, its pinned-artifact admission, and its place in the descriptor and index (no new field: `platforms` and the pinned rungs, §9.7 P4) | validate CLI passes for every tracked official source (`plugins/*/source` after the candidate wave retires `assistant`'s, §9.7 E2′), `templates/extension` (the former `templates/plugin`), the portal and repository plugins with the app not running; a non-JS smoke plugin (Python: a stock MCP server library plus a JSON-RPC library for the Ave peer channel) passes conformance | none for existing plugins; the schema vendoring, `hostProtocol` in the descriptor/index and the official plugins' declarations moved into Lease (§6.4) |
| Admission (app release 0.14.0; §9.8, decisions 48-62) | out-of-process by default for every install and every source (decision 3): the routing function has no input, the census `OUT_OF_PROCESS_PLUGIN_IDS` / `isOutOfProcessPlugin` is deleted and the in-process import call leaves main (§9.8 A1); the arm and the confinement (`PluginConfinementReport`: the spawn's wrap outcome, or `not-spawned`) on the Doctor's plugin report; `git`, `hello-world`, `templates/extension`, `portal` onto the path; adversarial fixture (§9.8 A2); plugins outside the official index distributed through another marketplace source, never the official index (decision 48); the official-URL switch when the repository is public (O1); the old server's retirement sequence (P7) | fixture attempts the four escapes (blueprint §9 Stage 9) under the real wrap and is denied on each, with control cases, after being built against the validate CLI; the routing matrix routes every `entry` manifest to `child` for every source kind, rung, install source and platform, and admits or refuses a `process` manifest explicitly; a refused prepared activation reports as a `PACKAGE_INCOMPATIBLE` (`host_protocol`) update failure and a refused restart through the config-save reply and the card's `lastAttemptRefusal`, both with the boot/add audit event and the running generation untouched; `allPluginsAreOutOfProcess`, fed by the registry's `arm`, is true, and a test routes every manifest of the official index to `child`; `git` 0.3.0: no `fetch` call site outside its bound `hostFetch`, its `networkAccess` in the manifest, its cache under a `sandbox.write` `userChosenDirectory` grant and the `~` refusal tested (planned; not started; awaiting owner go-ahead, decision 49) | `git` **prerequisites (decision 22)**: its direct `fetch` for GitLab/GitHub with cookie and token headers (`ave-plugin-repo` at `d71fb95`, `src/hostPlugin.ts:797-806`) and for plugin LLM calls (`:920-932`) move to `hostFetch` with `networkAccess` declarations; its optional external `dataDirectory`, expanded from `~` today (`:824-834`) and written under (`:1140`), becomes a `sandbox.write` `userChosenDirectory` grant on `configKey: "dataDirectory"` that requires a normalised absolute path and refuses `~`. These are not Lease work; the earlier "all mediated" claim is withdrawn (§9.2 item 7). No other plugin changes: a protocol-2 `entry` plugin gets the same `PluginHostApi` in its own process |
| Loader removal | remove the retained in-process factory function (`importInProcessPluginFactory`, §9.8 A1) and narrow the arm union | `plugin-loader.ts` exports no in-process factory path; `importPluginFactory`'s only importer is `plugin-child-main.ts`; `PluginLoadArm` has one member; condition and boundary as §9.3 restated by §9.8 (0.16.0 at the latest) | none |

Dual-run period: from the wire step until Admission, both loaders coexist as a
per-plugin routing decision from a host-owned set, never as a runtime fallback: a failed
child fails the call (`out-of-process-plugins.ts:14-15`, blueprint `:992-1001`). Admission
deletes that set (§9.8 A1, decision 50); from then until Loader removal the in-process
factory is retained with no production caller, so there is no routing input at all. In
neither period is there a No-Fallback exemption to grant.

### 9.2 Order of plugins

For the wire step (§9.4), in validation order: smallest surface first, so a wire defect
is found where it is cheapest to read. The four official plugins are cited in the
official repository (`OFFICIAL_MARKETPLACE.url`, `src/marketplace/sources/official.ts:27`)
at its commit `6a4d3b3df`, under `plugins/<name>/source/`; the portal and repository plugins are cited in
their own repositories at a pinned commit.

1. `assistant` — `triggerConversation`, `callLlm`, `onEvent`, `config`,
   `hasRoutineBySource`, `getInstalledPluginIds`, `onPluginsChanged`
   (`plugins/assistant/source/src/hostPlugin.ts:1038`); no worker, no window, no audio.
2. `mail` — `authRedirect`, `openAuthWindow`, `openAuthPartitionViewer`,
   `clearAuthPartition`, `storage.*Encrypted`, `probePrivateHost`
   (`plugins/mail/source/src/auth/msal-client.ts:113`); exercises the UI-action members.
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
6. `portal` — `openAuthWindow` ×5, `getAuthPartitionCookies`,
   `spawnWorker` ×3 (`ave-plugin-portal` at `2f17388`, `src/nativeAdClient.ts:91-96`), `probePrivateHost`;
   the largest surface and the one the blueprint records as "three unrelated problems"
   (blueprint `:1061`). Its `hostFetch` is bound once (`src/hostTransport.ts:45-52`); besides the
   browser-driving use, the partition's `user_id`/`refresh_token` cookies are read from
   the vault (`src/sessionVault.ts:65`; `src/portalClient.ts:154-161`) and sent as a JSON
   body through `hostFetch` (`:206-214`) for the service's token refresh — a
   session-credential crossing Lease does not remove (§4.1). It is not in the official
   index, so an install reaches it as a custom source or as a policy
   `additional` (managed) source; admission does not depend on which (decision 3).
   Last, so its cadence is decoupled.
7. `git` — not yet isolated; `openAuthWindow` ×4 (`ave-plugin-repo` at `d71fb95`,
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

- **Condition (state, not date):** as stated canonically in §9.8, "Loader removal,
  restated after Admission" — the registry-fed `allPluginsAreOutOfProcess` true on every
  Doctor report since Admission, the routing matrix, the official-index test and the
  conformance suite green on two consecutive release tags, and no change to the retained
  in-process factory in those releases — verifiable in the history of
  `src/plugins/runtime/plugin-loader.ts`, since there is no fleet telemetry. The earlier
  wording keyed the condition to the routing census, which Admission deletes (decision
  50); the two-release conformance requirement is unchanged.
- **Owner:** the organization owner role (the repository's sole maintainer; decision 5),
  recorded as that role in `TODO.md` when the wire step starts.
- **Version boundary:** the removal ships no later than two minor releases after the
  admission step lands, or the owner records why not in `TODO.md`.
- **What is deleted:** the retained in-process factory function
  `importInProcessPluginFactory` with `runPluginImportWithTimeout`,
  `PluginImportTimeoutError` and their tests, the `"in-process"` member of
  `PluginLoadArm` and its Doctor text, and the knip baseline entry that names this
  owner and condition (§9.8, "Loader removal, restated after Admission"; decision 59).
  `importPluginFactory` (`plugin-loader.ts:77`) stays as the child's. **Amended by
  §9.8:** `OUT_OF_PROCESS_PLUGIN_IDS`, `isOutOfProcessPlugin` and the in-process import
  call in main are deleted at **Admission** (A1), because routing has no input from
  then on; an earlier revision listed them here. The earlier citation of
  `ChildLocalPath` / in-process branches around `createHostApi`
  (`runtime/index.ts:2049-2058`) is withdrawn: no such branch exists at `c4c9689d2`.
  `PLUGIN_ENVELOPE_GRANTS` is not on this list: the Lease step deleted it (§2.2, §9.1),
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
   change; its callers are `child-stream-multiplex.ts:23`, `plugin-child-main.ts:32`,
   `src/mcp/experimental/stdio-server-loop.ts` and their tests. `mcp-client.ts` keeps
   its own line parser: it is the external boundary and has its own tests.
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
  `plugins/<id>/` for `assistant`, `mail`, `local-indexer`, `meeting` and
  `portal`, each a fixture entry module that calls exactly the members that plugin uses
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
0.11.0 and lists portal 0.22.0 among the successors; the inspected `portal` checkout is still
0.21.6, `package.json:3`). Those plugin versions are published for 0.11.0 **first**, at
their own immutable versions and pinned to the v0.11.0 tag through the release
process (`docs/development/release-process.md:66-76`: the checker's alerts release
option, minimums and the revocation selector agree). Lease then bumps every changed
plugin **again**: the next version of each after its alerts version, with
`minAppVersion` X and `hostProtocol: "2"`. A published artifact is never rewritten;
the branch's development pin (`contract/sources.json` on that branch pins commit
`b5d86c08d`, not a tag) is not a release receipt. There is no combined alerts/Lease
bump: the owner's decision is alerts versions first, Lease versions after, and this
document does not keep an exception to it. `assistant`'s revocation stays with
the 0.11.0 boundary and is not moved by Lease; a plugin the alerts release revokes is
outside the Lease replacement set (§6.4, applicability).

**Sequence.** Each step is a gate for the next; none is skipped because a previous
step deployed something.

1. **Candidate artifacts, before the tag.** Rebuild `meeting`, `local-indexer`,
   `mail`, `assistant` (only if not revoked by the alerts release),
   `hello-world`, the portal and repository plugins against the candidate host contract, update
   `templates/plugin` in source, and run the plugin acceptance of §9.1 against a
   packaged candidate app. Candidate-ref syncs are development evidence only; the
   notice gate of §9.3 is met before step 2.
2. **App tag, installer held as a draft.** Slice E1 (§9.6) regenerates the schema at
   the final version, adds the tag-named mirror copy, passes the full gates once, and
   the app is tagged X. `build-installers.yml` attaches the installers to a **draft**
   release (`.github/workflows/build-installers.yml:308-316`), so the tag exists without
   a broad rollout. Nothing that must be vendored from the tag is required before it.
3. **Re-vendor from the tag.** The official repository's `tools/vendor.mjs sync`, `portal`'s
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
   which case the alias stays (§6.1; §9.7 M1, decision 39); the mirror check holds it
   there.

Rollback: an app release X that fails step 4 stays a draft and is superseded by a new
tag, never rewritten; published plugin artifacts are never withdrawn, because an older
app keeps the versions already installed from its last pin (decision 24).

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
| **E2. Release runbook, after the tag** | §9.5 steps 3-6: final-tag vendor receipts in the three plugin repositories and the official checker rebuild, plugin releases and index/descriptor pins, the §6.4 matrix against published artifacts, app draft publication, then the alias-promotion `web` PR. These are gates on the published release, not inputs to creating the tag | source/tag/vendor hash equality per repository; published manifests, hashes and index entries verified; 0.10 and 0.11 binaries against the published source; the alias changes only in a commit that sets a `publishedTag`, and always equals the newest published copy of its protocol (§9.7 M1: a `2/v0.12.0` promotion after `2/v0.13.0` sets the tag and leaves the alias) | none in the app tree except the alias PR under `web/` |

Validation discipline: narrow tests while iterating (`bun run test:vitest -- run <dirs>`),
`bun run typecheck`, then the full `bun run test` and `bun run build` once before
publication of each slice; in-process arm tests run for D while that arm exists; a
failed or unavailable verification is recorded as such and never replaced by a
permission or lifecycle fallback that makes the test pass.

### 9.7 The Publication step: implementation plan

Scope is the "Publication" row of §9.1, shipping in app release **0.13.0**. Every
citation in this section is ave at `c73f59580` (main, 2026-09-28: after the plugin
studio, after **#2589**, `f00595d10`, which bumped `package.json` to `0.13.0` and opened
the `2/v0.13.0` mirror candidate, and after **#2590**, which retired the manifest
`notificationEvents` field and refreshed that candidate) unless a repository is named;
the official repository is cited at its `main`, `6a4d3b3` (unchanged since the Lease
amendment), and its plugin-repository companions at the commits §6.3 names. Nothing a
plugin author sees changes for an existing `entry` plugin: no member, signature or
manifest field of theirs moves. What Publication adds is a second
way to consume the protocol (the TS client), a way to prove a plugin against it without
the app (the validate CLI), and the runtime for the second way to produce the process
(`process`). Admission — out of process by default, the adversarial fixture, the `git`
prerequisites — is not in 0.13.0; what this step leaves ready for it is listed at the
end.

#### Facts this plan rests on

Verified on 2026-09-28, each with the source that proves it. Facts 8-12 were added in
the second design round, from the two reviews that found the first round's plan unsafe
or wrong at the places they name. Facts 13-17 were added in the third round
(2026-10-01), from the two re-reviews that found S1's interface under-specified. During
that round `main` moved to `9c56ec148` (#2591, M1 implemented as specified below); it
changed only the mirror scripts, their test and two documents, so every anchor outside
`scripts/lib/plugin-host-protocol-mirror.mjs`, `scripts/sync-plugin-host-protocol-mirror.mjs`
and `test/scripts/plugin-host-protocol-mirror.test.ts` reads the same at both commits,
and the mirror anchors are split on purpose: fact 5 and "The mirror freeze" describe
the checker as it is now and cite `9c56ec148`; the M1 subsection and decision 39 keep
`c73f59580`'s, the tree M1 was specified and reviewed against.

1. **The stock MCP server SDKs speak `2026-07-28`** (closes the UNVERIFIED item).
   - Python: `mcp` **2.0.0** (2026-07-28) is the stable v2 line and "speaks the
     2026-07-28 revision (stateless requests with no handshake, `server/discover`,
     `subscriptions/listen`, multi-round-trip requests) and still serves every 2025-era
     client from the same `MCPServer`"; `pip install mcp` resolves to 2.x. Its stdio
     server "decides the protocol era from the client's opening request" (#3152, in
     2.0.0rc1 and stable). Newest at the check: **2.2.0** (2026-09-07), which requires
     **Python ≥ 3.10** (`requires-python` in the tagged `pyproject.toml`; PyPI
     `mcp/2.2.0`).
     Sources: <https://github.com/modelcontextprotocol/python-sdk/releases> (tags
     `v2.0.0`, `v2.0.0rc1`, `v2.2.0`), <https://py.sdk.modelcontextprotocol.io/v2/>,
     <https://pypi.org/project/mcp/2.2.0/>.
   - TypeScript: the **2.x** packages (`@modelcontextprotocol/server`, `client`, `core`,
     `node` at 2.0.0 on 2026-07-27 and 2.1.0 on 2026-09-23) speak `2026-07-28`; the
     `@modelcontextprotocol/sdk` **1.x** line (1.30.1, 2026-09-23) is the legacy line and
     is what ave pins (`package.json:128`, `1.30.0`) for its own external MCP client.
     Source: <https://github.com/modelcontextprotocol/typescript-sdk/releases>.
   - Specification: servers **MUST** implement `server/discover`; every request carries
     the protocol version and the client capabilities in `_meta` (fact 16 names the host
     side that must produce them); there is no `initialize` at `2026-07-28`
     (<https://modelcontextprotocol.io/specification/2026-07-28/changelog> items 2-3,
     <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>).
     `server/discover` answers versions and capabilities, **not** tool definitions:
     those come from `tools/list` (the `DiscoverResult` schema at
     <https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts>;
     in the host, `manifestToDiscoverResult` at `src/mcp/plugin-server-projection.ts:162-184`
     advertises `capabilities.tools` and `supportedVersions`, and `tools/list` at
     `src/mcp/plugin-mcp-server.ts:115-122` lists the tools).
   - Consequence for the design: no stock library speaks `ave/host/*` or
     `ave/instance/*`, and every stock stdio driver owns the process's stdin and stdout.
     So the Python smoke (P5) owns the stream itself — one newline-delimited JSON-RPC loop
     that routes `ave/*` to its own handlers and hands each MCP request to the library's
     in-memory server kernel one message at a time — and the host adds no shim of any
     kind: the host speaks exactly what §2.5 and §3 already say, and the reference runtime
     is unchanged.
2. **`ts-json-schema-generator` 2.9.0 reads the three source files** (closes the second
   UNVERIFIED item): it is the generator's engine in production
   (`scripts/lib/plugin-host-protocol-schema.ts:25`, `:46`; `package.json:200`, with
   TypeScript `^7.0.2` at `:203`), `check:plugin-host-protocol-schema` runs in `build`
   (`package.json:47`) and `schemas/plugin-host-protocol/2/protocol.schema.json` is
   committed and mirrored. The compiler-API fallback of §9.4 item 7 was not needed.
3. **The schema compiles to TypeScript with `json-schema-to-typescript` 15.0.4.**
   Reproduced on 2026-09-28 in a scratch directory outside the checkout (`npm install
   json-schema-to-typescript@15.0.4`, then `compile()` over a root that `$ref`s every
   entry of `git show c73f59580:schemas/plugin-host-protocol/2/protocol.schema.json`):
   57 `$defs.types`, 51 methods and 8 notifications compile with no error, and the
   output passes `tsc --noEmit --strict --target es2022 --module esnext
   --moduleResolution bundler` with the repository's TypeScript 7.0.2. The number of
   exported declarations depends on how the wrapper root is shaped (the first round's
   "47" and this round's 103 are both artefacts of the harness) and is not a claim this
   plan rests on. `type: object` members with no properties become `unknown`, which is
   the right reading of them. This is the one new dev dependency of this step (P1),
   never bundled; P1's byte and compile gate is what makes the reproduction a gate.
4. **Slice C of the extensions design left one refusal in seven places, and the
   manifest schema already carries `process`.** The marker `hasProcessEntry`
   (`src/plugins/process-entry-support.ts:20-24`) and the code
   `process-entry-unsupported` are raised at `manifest-validation.ts:916` (the hardening
   pass, before the `entry` check at `:917`), `marketplace.ts:833` (the staged-zip
   transaction, `installZipTransaction`, `:770`) and `:1029` (`installLocal`),
   `manifest-rules.ts:107`, `direct-package.ts:118-120`, `plugin-ladder.ts:156-158`
   (message text), and `runtime/index.ts:5392-5394` (Doctor kind). The code is in the
   closed sets `PLUGIN_INSTALL_FAILURE_KINDS` (`src/shared/plugin-install-failure.ts:5`,
   `:55`), `MARKETPLACE_ERROR_CODES` (`src/marketplace/errors.ts:37`), the IPC result
   (`src/ipc/domains/plugins.ts:486-488`, `src/shared/plugin-install-result.ts:56-60`) and
   the two locale catalogs (`src/i18n/messages/en.ts:75`, `ko.ts:70`; keys
   `formatIpcError.processEntryUnsupported`, read by `format-ipc-error.ts:9`,
   `tabs/git-marketplace/labels.ts:114` and `src/ui/renderer/tabs/PluginConfigTab.tsx:519-520`,
   `:855`, `:874`, `:896-897`, which the first round missed). The manifest schema **does** know `process`:
   `extensions["ai.agent-connector.ave"].process` is at `schemas/plugin-manifest.schema.json:1121-1160`
   — closed, `command` required (1-200 chars, pattern
   `^(?:[A-Za-z][A-Za-z0-9._-]*|\./(?:[^/\\]+/)*[^/\\]+)$`, so a **bare name is
   admitted today**, no CR/LF), `args` ≤ 64 strings of ≤ 1000 chars, `env` ≤ 64 keys
   named `^[A-Za-z_][A-Za-z0-9_]{0,63}$` with values ≤ 4096 chars — and the namespace's
   `oneOf` at `:1194-1222` makes `entry`+`tools` (with `process: false`, `mcpAuth:
   false`), `process`+`tools` (with `entry: false`, `mcpAuth: false`) and the
   neither-branch (no `entry`, `process`, `tools`, `onboarding`, `config`, `ui`, …)
   mutually exclusive. Decision 4's "in the schema from protocol `1`" therefore did
   happen; what P3 does is **tighten** that branch (the inventory is in P3) and make the
   runtime honour it. The first-round claim that the schema lacked `process` was wrong at
   both `5ce7a0282` (`:1148`, `:1221`) and `c73f59580`. The eleven test sites that pin
   the code are `plugin-doctor-load-classification.test.ts:54`, `:63`,
   `install-local.test.ts:110`, `plugin-ladder.test.ts:293`, `manifest-rules.test.ts:105`,
   `sync.test.ts:606`, `plugin-install-failure.test.ts:56`, `:88`,
   `hooks/status-bar/__tests__/install-result-payload.test.ts:104`,
   `src/ui/renderer/__tests__/PluginConfigTab.test.tsx:453` and
   `tabs/git-marketplace/__tests__/GitMarketplaceTab.test.tsx:186`.
5. **The mirror.** `web/public/schemas/plugin-host-protocol/mirror.json` lists three
   copies: `1/v0.11.0` published (`publishedTag: "v0.11.0"`, alias `1` → it),
   `2/v0.12.0` with `publishedTag: null`, `generatedFrom: 87caad4fc` (the v0.12.0 tag's
   bytes, awaiting its E2), and `2/v0.13.0` with `publishedTag: null`. That third entry
   has two receipts in history: **#2589** (`f00595d10`) recorded `sha256: c7ca0e2d…`,
   `generatedFrom: 5ce7a0282` (`git show f00595d10:web/public/schemas/plugin-host-protocol/mirror.json`),
   and **#2590** refreshed it after retiring `notificationEvents` to `sha256:
   d278eb4d…`, `generatedFrom: f00595d10` (`mirror.json:17-22` at `c73f59580`). The
   first-round text conflated the two; #2591 left `mirror.json` and every copy untouched.
   `package.json` is `0.13.0`, so the check (`scripts/lib/plugin-host-protocol-mirror.mjs:58-148`
   at `9c56ec148`) classifies `2/v0.13.0` as the **candidate** (`:83`) and holds it
   byte-equal both to its recorded sha256 (`:79`) and to the canonical
   `schemas/plugin-host-protocol/2/protocol.schema.json` (`:86-89`), while `2/v0.12.0` is
   unpublished-and-superseded, held to its own hash only. There is **no alias `2`** and
   no `2/protocol.schema.json` on the site yet, because E2 of the Lease step waits for
   GitHub Actions. The "alias must name the latest published copy" rule (`:119-123`)
   now runs **whether or not the protocol has an open candidate**; only the
   canonical-equals-newest-published rule is candidate-gated (`:124-130`). At
   `c73f59580` the first rule was skipped too (the `continue` at `:107`); removing that
   skip was M1 (#2591; decision 39). Promotion is `node
   scripts/sync-plugin-host-protocol-mirror.mjs --publish <protocol>/<version>`
   (`scripts/sync-plugin-host-protocol-mirror.mjs:10-12` → `publishProtocolMirror`,
   `plugin-host-protocol-mirror.mjs:184-203`), which sets the copy's `publishedTag` and
   points the alias at the newest published copy.
6. **The official repository, its drift scripts, and the monorepo wave.** At `main`
   `6a4d3b3`, `tools/vendor.mjs` holds two vendored directories, `contract/` and
   `tools/vendor/` (`:30`), each described by a `sources.json` whose entries are copies
   (`from`) or bundles (`build`, built with `bun build <entry> --target=node --format=esm`
   by a recorded bun version, `:77-91`); `contract/sources.json` pins `v0.10.0` and two
   files; `tools/vendor/sources.json` pins `8ccbbf3fe` and one bundle,
   `marketplace-check.js`, from `src/marketplace/repository-check.ts` with bun `1.3.14`.
   Three plugins and the template carry `scripts/validate-hostapi.mjs`
   (`plugins/{local-indexer,meeting,mail}/source`, `templates/plugin`), wired as
   `validate:hostapi` scripts and run by the shared workflow step "Manifest drift checks"
   (`.github/workflows/validate.yml:111-118`), which runs whichever of `validate:events`
   and `validate:hostapi` a plugin declares; the workflow discovers **every** tracked
   `plugins/*/source/plugin.json` (`:74-78`). At `6a4d3b3` that set includes
   `assistant`, whose manifest declares no `hostProtocol`, `minAppVersion:
   "0.10.0"` and `notificationEvents` (`plugins/assistant/source/plugin.json:254`,
   `:314-315`) and which §9.5 excludes from replacement (revoked). The **candidate
   wave** on `feat/lease-candidates` (`e53fb40a8`, readable at
   `/private/tmp/lease-mono/agent-marketplace`; the branch has since moved to `556ebd3`,
   a descendant, which changes none of what follows) resolves this on the plugin side: its
   commit `0835fd2` "Add agent plugin catalog and retire assistant plugin source" deletes
   `plugins/assistant/source` and keeps both catalog files'
   and `policy/revocations-by-app.json` entries; the template moves to
   `templates/extension`; discovery becomes `git ls-files 'plugins/*/source/plugin.json'
   'templates/extension/plugin.json'` (`validate.yml:78` in the wave) and yields
   `hello-world`, `local-indexer`, `meeting`, `mail` and the template, all declaring
   protocol `2`; the drift step is unchanged (`:111-118`) and the four
   `validate-hostapi.mjs` scripts are still there. The drift script cross-checks
   `emitEvent`/`onEvent` names and `bridge.callTool`/`bridge.onEvent` targets against the
   manifest (`plugins/meeting/source/scripts/validate-hostapi.mjs:4-17`); its first three
   checks read a `permissions` list that is still in the manifest schema
   (`schemas/plugin-manifest.schema.json:219`) but that the host does not enforce. `portal`
   (`2f17388`) has `validate:events` and an Ajv `validate:manifest`; its
   `tools/contract.mjs` holds the inventory to exactly two files (`:18-30`) and can only
   **copy** a file from a ref (`git show` or the GitHub contents API, `:44-61`; `sync`
   writes and hashes copies, `:112-115`). `git` (`d71fb95`) has `check:manifest` and its
   own `tools/vendor.mjs`, release tag required (`:18`, `:107`), which likewise only copies
   (`:76-83`, `:110-113`). Neither can build a bundle, and neither repository's
   verification workflow checks out ave or installs bun for it.
7. **The confined-child suite already proves stdin-close exit for the reference
   runtime** (`confined-plugin-child.test.ts:1833`, "exits within five seconds of its
   stdin closing"). The process-entry variants are new work (P5). The suite's live-sandbox
   cases run only where `asrtCanInitialize()` is true and otherwise **return green
   without measuring** unless `AVE_REQUIRE_SANDBOX_CASES=1` (`:188-216`); in CI only the
   macOS job sets it (`.github/workflows/ci.yml:327-375`, the flag at `:372`, the reason
   in the comment at `:361-366`); the Linux `build-and-test` job (`:11`, `runs-on:
   ubuntu-24.04-arm` at `:21`) has no bubblewrap. ASRT on Linux checks for `bwrap` **and**
   `socat` (`node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js:372-373`,
   `:392-393`), scans deny paths with `rg` (`:168-172`, "Get mandatory deny paths using
   ripgrep"), ships seccomp filters for `x64` and `arm64`
   (`node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/`), and its README lists
   `bubblewrap`, `socat` and `ripgrep` as the Linux requirements and says that Ubuntu
   24.04+ "enable `kernel.apparmor_restrict_unprivileged_userns` by default", which strips
   the capabilities bubblewrap needs, to be disabled with `sudo sysctl -w
   kernel.apparmor_restrict_unprivileged_userns=0` (`node_modules/@anthropic-ai/sandbox-runtime/README.md`,
   "Platform-Specific Dependencies"). There is no Linux confinement job today; P3 adds
   one.
8. **Every activation path reaches the factory through one funnel, and the integrity
   evidence drops the rung.** `importPluginFactoryForLifecycle`
   (`src/plugins/runtime/index.ts:5143-5167`) is called from boot
   (`instantiatePreflightedPlugin`, `:5360`, call at `:5498`), post-boot add
   (`instantiateAndStartSinglePlugin`, `:3827`, call at `:3964`), prepared activation
   (`activatePreparedArtifact`, `:4789`, call at `:4857`) and restart
   (`restartPluginInternal`, `:6083`, call at `:6240`). Integrity runs per path —
   `verifyReceiptAndDevGuard` at `:3839` (add), `:5189` (boot preflight) and `:6121-6123`
   (restart) — but `activatePreparedArtifact` materialises from the staged
   `input.receiptRaw` (`:4840`, `:4851`) without a verification of its own, and
   `verifyPluginIntegrity` (`:1562-1592`) returns `verified: { installSource,
   artifactSha256, signerKeyId }` (`:1445-1452`), **without the receipt's `git.rung`**
   (`plugin-install-receipt.ts:47-95`), while accepting `local-dev` (dev-unlocked) and
   tree-rung `git` receipts. A gate that reads only the marketplace install path would
   therefore leave an already-installed tree-rung or hand-placed process manifest able to
   reach the runtime through boot, restart or prepared activation.
9. **What the spawn's environment reaches.** `buildSafeChildEnv(extra)` forwards an
   allow-list of host variables and spreads `extra` over it (`src/tools/safe-env.ts:62-70`);
   `spawnConfinedChild` hands `composeConfinedEnv(baseEnv, wrappedEnv, extraEnv)` to
   `spawn` for the **outer** executable (`src/permissions/confined-child.ts:114-120`),
   and with the sandbox active that executable is ASRT's wrapper, `/bin/bash -c
   <wrapped>` on macOS and Linux (`node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js:1473-1481`).
   Any variable placed in `baseEnv` or `extraEnv` is therefore read by that outer shell
   **before** the sandbox command runs — a `BASH_ENV` there is sourced unconfined. The
   command line itself is shell-quoted token by token (`confined-child.ts:189-200`) and
   runs inside the wrap. The host already owns a reserved-name rule for manifest-supplied
   environment names: `isSafeMcpEnvironmentName` (`src/mcp/safe-names.ts:50-53`) refuses
   `RESERVED_ENV_NAMES` (`:27-46`: `PATH`, `HOME`, `LD_*`, `DYLD_*`, `NODE_OPTIONS`,
   `BASH_ENV`, `ENV`, `PYTHONPATH`, `PYTHONSTARTUP`, …) compared through `toUpperCase()`,
   the launcher family `LAUNCHER_ENV_NAME_RE` (`:49`, a case-insensitive `/iu` pattern)
   and the names `PLUGIN_ROOT` and `PLUGIN_DATA` — those two **case-sensitively**
   (`name !== "PLUGIN_ROOT" && name !== "PLUGIN_DATA"`, `:53`), which P3 corrects
   (host re-review #23).
10. **Path anchoring today.** `anchorBundledCommand` requires every anchored token to
    resolve, through `realpath` and `O_NOFOLLOW`, to a **regular file** inside the retained
    plugin generation (`src/plugins/plugin-bundled-command.ts:45-58`); the argv resolver
    treats `${PLUGIN_ROOT}/…` and `./…` as anchored (`resolve-bundled-argv.ts:83-84`),
    `${PLUGIN_DATA}…` through `containedDataPath` (`:42-51`, nearest existing ancestor
    realpath'd inside the data root; the leaf need not exist), and refuses any other
    token that contains `${` or looks like a path (`:97`). A directory-valued
    `${PLUGIN_ROOT}/vendor` fails the regular-file rule; a process entry needs directories.
11. **The decoder is tolerant by design.** `StdioFrameDecoder` drops a line that is not a
    JSON object and keeps going (`src/mcp/stdio-framing.ts:35-46`, `:88-95`); a bare
    `ready` line or a `Content-Length:` header is dropped, not refused, and the next valid
    frame is still returned. Counting decoded frames cannot detect either. Stdout
    discipline is therefore provable only by inspecting the raw bytes beside the decoder.
12. **The factory, the goldens and the checker.** `createOutOfProcessPluginFactory`
    (`src/plugins/isolation/out-of-process-plugin.ts:1144`) does admission (protocol
    check `connectionHostProtocol`, `:1156`; envelope; registration) and then `connect`
    (`:1178`), whose default is the confined spawn and whose substitution
    (`OutOfProcessPluginSpec.connect`, `:1001`) is how the goldens exercise the protocol
    over paired streams; the transport is built from `child.link` at `:1205` and the
    factory ends by returning the `RuntimePlugin` whose `stop` closes the transport and
    terminates the link (`:1496-1519`; `plugin-child-transport.ts:203-215`). Construct is
    the **first** frame the host sends (`:1436-1445`), and the reference runtime answers
    any MCP request before construct with `-32601` (`plugin-child-main.ts:308-319`),
    redirects plugin stdout to stderr before plugin code runs (`:18-25`) and exits itself
    on stdin end (`:382-392`), so an `entry` fixture cannot misbehave on stdout or ignore
    stdin close. Four protocol-2 golden fixtures (`portal`, `meeting`, `mail`,
    `assistant`) hold no `entry.mjs`; the harness maps their code from the protocol-1
    fixtures (`host-protocol-golden.test.ts:64-66`, `:700-707`). The golden host is
    `createGoldenHost` in `host-protocol-golden-host.ts:79`, with a worker double whose
    name carries the `fake` prefix (`:95`, `:175`); a production file may carry neither a `mock-`/`fake-` filename prefix nor
    `mock`/`fake` identifiers (`.github/scripts/naming-gate.sh:115-123`, `:235-246`).
    `ExpectedPlugin` (`src/marketplace/resolve/manifest-rules.ts:33-39`) carries `name`,
    `version`, `minAppVersion`, `hostProtocol?`, `authority` and nothing about platforms
    or pins; its producers build it by hand (`plugin-ladder.ts:172`,
    `repository-check.ts:97-105`, `:135`), while `PackagePlan` does carry `platforms`
    (`src/marketplace/resolve/descriptor.ts:32`) and `PluginInstallPlan` carries
    `artifact: PluginArtifactPins` (`plugin-ladder.ts:44`; `catalog/types.ts:108-119`). Catalog selection excludes a version by
    `min_app_version`, `host_protocol` and `platform` (`catalog/aggregate.ts:85-89`).
    `checkReleasedManifests` already holds each released manifest to **its own** index
    version (`repository-check.ts:125-139`). The root `tsconfig.json` includes `src` and
    `scripts` and excludes `src/**/__tests__/**` (`:24-34`), so a file imported only from
    a test is outside `bun run typecheck`; `tsconfig.tests.json` is a baseline ratchet,
    not a clean gate.
13. **The dispatcher's authority is the spawn's envelope, and the factory is the only
    place that holds both.** `createBoundHostApiDispatchTable(hostApi, confinement,
    onMalformedCredentialSelector?)` (`out-of-process-plugin.ts:155-173`) binds the four
    member groups over the shipped table, and its `confinement` is documented as "the SAME
    value `spawnConfinedPluginChild` passes to the wrap" (`:157-165`); the factory derives
    the envelope once (`:1161-1174`) and hands that one value to the spawn (`:1180`) and to
    the table (`:1198-1203`). `createServiceHostApiPaths` requires it "rather than optional:
    an omitted envelope would silently mean 'unbounded'" (`host-api-dispatcher.ts:1352-1360`).
    `derivePluginChildEnvelope` (`out-of-process-plugin.ts:653-702`) yields a base of
    `read: [pluginRoot, pluginDataDir, socketDir, workerRunRoot]`, `write: [pluginDataDir,
    socketDir]` (`:670-671`) and widens it only for the manifest's `sandbox` grants, reading
    the user's approvals from `~/.ave/config/settings.json` for a `userChosenDirectory` grant
    (`:646-651`). None of the five protocol-2 golden fixtures declares `sandbox`.
14. **What the transport can and cannot do today.** `PluginChildTransport.request`
    (`plugin-child-transport.ts:168-188`) sends any method with the caller's params
    unchanged; `close` (`:203-218`) calls `link.terminate` (`:215`) — so the factory's
    `instance.stop` (`out-of-process-plugin.ts:1496-1524`), which runs the plugin's stop hook
    and then `transport.close` (`:1517`), always ends in a termination, and there is no
    operation that closes stdin alone. The host is a client and never a server on these
    pipes: a frame in the server direction that is not a host request or a notification is
    dropped (`plugin-child-transport.ts:242-247`). `ChildLink` (`:72-94`) is the child's two
    pipes plus `terminate` and `onGone`; `ConfinedPluginChild` (`out-of-process-plugin.ts:748-751`)
    adds only `waitForExit`, not the process id.
15. **Deleting `connect` touches more than the goldens.** `OutOfProcessPluginSpec.connect`
    (`out-of-process-plugin.ts:998-1001`) is substituted at 20 sites in
    `out-of-process-plugin.test.ts` (`:291` to `:1031`), at four in
    `child-process-config-wire.test.ts` (`:356`, `:438`, `:510`, `:562`, all with
    `connectPlainChild`, `:198-226`, an unconfined real child), at two in
    `confined-plugin-child.test.ts` (`:1858`, `:1920`, which wrap the **real**
    `spawnConfinedPluginChild` only to capture the link for the stdin-close case, `:1870`,
    and the raw stdout, `:1922-1924`) and at two in `host-protocol-golden.test.ts`
    (`:203-208`, and the throwing `connect` of "refuses an old bundle before its child
    connects", `:690-695`). `createGoldenHost` is imported by
    `host-protocol-schema-parity.test.ts`, `confined-plugin-child.test.ts` and
    `host-protocol-golden.test.ts`; `createBoundHostApiDispatchTable` by the factory,
    `out-of-process-plugin.test.ts` and `host-protocol-schema-parity.test.ts`.
16. **The out-of-process arm sends MCP requests without the modern metadata.** MCP
    `2026-07-28` requires `_meta["io.modelcontextprotocol/protocolVersion"]` **and**
    `_meta["io.modelcontextprotocol/clientCapabilities"]` on every request; a request
    missing either "is malformed; the server **MUST** reject it with JSON-RPC error code
    `-32602`"; `clientInfo` is a SHOULD, self-reported, for display
    (<https://modelcontextprotocol.io/specification/2026-07-28/basic>, "Per-request
    protocol fields"; <https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning>;
    both read 2026-10-01). The factory's `tools/call` (`out-of-process-plugin.ts:1472-1480`)
    and `resources/read` (`:1542`) send bare params and the transport forwards them
    unchanged (`plugin-child-transport.ts:182`). The reference runtime's server tolerates
    a request with no `_meta` version by design ("e.g. an internal caller",
    `src/mcp/plugin-mcp-server.ts:233-252`), which is why no golden noticed. The key names
    are constants already (`src/mcp/protocol-constants.ts:18`, `:41-43`), and the
    in-process loopback host stamps all three (`src/mcp/plugin-mcp-host.ts:310-320`).
17. **Provisioning and bundling facts behind P5 and E2′.** The app's development uv is
    **0.7.3** (`scripts/fetch-uv.mjs:28`; `resources/uv/darwin-arm64/uv --version`). Its
    `uv python install` takes `--install-dir` / `UV_PYTHON_INSTALL_DIR`, and its `uv python
    find` takes `--managed-python` (help output of that binary, 2026-10-01). uv searches
    managed installations in `UV_PYTHON_INSTALL_DIR` and **then `PATH`**
    (<https://docs.astral.sh/uv/concepts/python-versions/#discovery-of-python-versions>);
    from uv **0.8.0** `uv python install` also links an executable into a `PATH`
    directory by default, overridable with `UV_PYTHON_BIN_DIR` (since 0.4.29) and
    disabled with `UV_PYTHON_INSTALL_BIN=0` (since 0.8.0)
    (<https://docs.astral.sh/uv/reference/environment/>;
    <https://github.com/astral-sh/uv/blob/main/changelogs/0.8.x.md>, "0.8.0"; both read
    2026-10-01). The CI `build-and-test` job ensures uv explicitly because a restored
    `node_modules` cache skips the postinstall (`.github/workflows/ci.yml:68-74`); the
    macOS job (`:327-360`) has no such step. In the official repository at the candidate
    wave (`e53fb40a8`), `tools/vendor.mjs` refuses a `build` entry whose `logger` is not
    `"stub-app-logger"` (`:92`) and builds by evaluating `tools/bundle-app-marketplace.mjs`
    with `bun -e` from the app checkout (`:103-105`), which replaces the app's
    `src/lib/logger.js` with a silent logger (`bundle-app-marketplace.mjs:16-29`); its
    `tools/vendor/sources.json` pins `v0.12.0` and two such bundles, and `checkVendored`
    refuses a bundle with an embedded absolute build path (`vendor.mjs:37-43`, `:71`).
    The app logger writes to **stdout** unless the process is a headless run
    (`src/lib/logger.ts:70-99`), and `plugin-child-main.ts` reaches it (reproduced
    2026-10-01: `bun build` 1.3.14 of that entry at `c73f59580` lists `src/lib/logger.ts`
    and `pino` among its inputs, and the same entry built with the wave's recipe contains
    no `pino` and passes the embedded-path rule).

#### The mirror freeze, and when the 0.13.0 candidate appears

The mirror check makes the canonical protocol schema **frozen on `main` from a tag
until the next version bump**, and the bump is therefore the first change after the
tag (`docs/development/release-process.md`, "Between releases: the next protocol
candidate", added by #2589). Exactly what happened, and what it means for this plan:

- **Enforced since 0.14.1.** The check now compares every recorded copy whose version
  has a `v<version>` tag in the checkout with the canonical schema that tag carries,
  published or not, and `syncProtocolMirror` refuses to write such a copy
  (`scripts/lib/plugin-host-protocol-mirror.mjs`, `checkTaggedCopy`). Before that, a
  candidate left at a tagged version (`3/v0.14.0`, `publishedTag: null`, with
  `package.json` still at `0.14.0`) passed the check after being regenerated with a
  later protocol change. A version with no tag yet (the open candidate, including
  the release script's pre-tag sync) is not compared; a checkout that cannot say
  whether a version is tagged — shallow, without any `v*` tag, or not a git
  repository — is refused, so CI checks out full history (`fetch-depth: 0`) in
  every job that builds or checks the mirror.

- **Between the v0.12.0 tag and #2589.** With `package.json` at `0.12.0` and `2/v0.12.0`
  at `publishedTag: null`, that copy was the candidate, and the check refused any `main`
  commit whose canonical schema differed from it (`plugin-host-protocol-mirror.mjs:83-89`
  at `9c56ec148`, unchanged in behaviour since the tag). Regenerating that candidate would
  have passed the check (`syncProtocolMirror` overwrites an unpublished entry,
  `:164-174`) but would have put bytes behind
  `…/2/v0.12.0/protocol.schema.json` that the v0.12.0 tag does not carry, which decision
  6 forbids. The §6.1 sentence "refused unless the candidate is regenerated in the same
  change" applies only while no tag carries the candidate's bytes, and is amended to say
  so.
- **The 0.13.0 candidate appeared on 2026-09-28 in #2589 (`f00595d10`), the first
  change after the tag**, exactly as the convention says: `package.json` → `0.13.0`,
  `bun run generate:plugin-host-protocol-schema` (new `$id`
  `…/2/v0.13.0/protocol.schema.json`) and `node scripts/sync-plugin-host-protocol-mirror.mjs`,
  which wrote `web/public/schemas/plugin-host-protocol/2/v0.13.0/protocol.schema.json`
  and appended `{ protocol: "2", appVersion: "0.13.0", sha256: "c7ca0e2d…",
  generatedFrom: "5ce7a0282", publishedTag: null }`. The check's stale-candidate error
  now names that command (`:88`). #2590 then changed the protocol (retiring
  `notificationEvents`) and refreshed the same candidate to `sha256: "d278eb4d…",
  generatedFrom: "f00595d10"` (fact 5), which is the pattern every 0.13.0 protocol
  change follows; the cited tree `c73f59580` is the result.
- **What the open candidate means for Publication.** A slice that changes the protocol
  schema regenerates `2/v0.13.0` in the same PR; the check permits it and no tag
  contradicts it. The one such slice is **P3**, and its change is **not** a description
  alone: construct carries `PluginManifest` (`plugin-instance-wire.ts:82`;
  `protocol.schema.json:7116-7117`), whose `required` list names `entry`
  (`:7503-7508`), so replacing it with the exclusive `EntryPluginManifest | ProcessPluginManifest` union
  changes a published wire type and the generated client (decision 33). P3 merges after
  P1 (the one merge order) and regenerates the schema, the candidate and the client in
  one PR, and the chain schema → mirror → client stays green. P1
  adds a file beside the schema, P3 also changes the *manifest* schema (not versioned by
  protocol, not mirrored), and M1, S1, P2, P4 and P5 change no schema. The client changes
  whenever any `$defs.types`, method or notification changes, not only when a method set
  changes; the first-round "methods only" claim is withdrawn.
- **`2/v0.12.0` stays `publishedTag: null` until its E2.** From #2589 the check treats
  it as an orphan — frozen against its own hash only (`:79`) — until Lease's E2 sets
  `publishedTag: "v0.12.0"`. **That E2 and the 0.13.0 release commute only once M1 has
  merged, and it now has.** At `c73f59580` the alias rule read only published copies
  (`:88-99` there) and the newest-published rule (`:108-112` there) was skipped while a
  candidate was open (`:107` there), so after the v0.13.0 tag and the next bump (which
  opens a `2/v0.14.0` candidate) a late Lease promotion following §9.5's old "promote the
  alias to its copy" wording would have moved alias `2` **back** to `v0.12.0` unnoticed;
  and without a candidate, following that wording after a 0.13.0 promotion would have
  failed the check instead.
  M1 (decision 39; merged as #2591, `9c56ec148`, on 2026-10-01) makes the rule
  order-independent — the alias for a protocol always names its newest published copy,
  candidate open or not, and a promotion of an older copy sets its `publishedTag` and
  leaves the alias — and is a prerequisite of both promotions (Lease's E2 and E2′ item
  3). §6.1, §9.5 step 6 and §9.6's E2 row are amended to the same rule.
- **The release PR (E1′) does not bump again.** `scripts/release.mjs` bumps the patch
  version unless `AVE_RELEASE_VERSION` names the version (`:106`), so E1′ runs it with
  `AVE_RELEASE_VERSION=0.13.0`, regenerates the schema and the client and refreshes
  the candidate once more at the final commit, as the convention's last sentence says.

#### Slices

Each slice is independently mergeable to `main`, coherent at its own boundary (a field,
its schema, its producers and consumers, its enforcement and its tests travel together),
and implementable in a separate checkout. Dependencies are stated; everything else may
run in parallel. Two slices were added in the second round: **S1**, which freezes the
protocol-session interface before the validator and the process runtime fan out (the
first round had P2 and P3 demanding incompatible behaviour from one factory), and **M1**,
the mirror alias rule.

| Slice | Scope | Depends on | May run beside |
|---|---|---|---|
| **P0. Design** | this section; §2.1, §6.1, §6.2, §9.5, §9.6, §10.2, §13 and the UNVERIFIED list amended | — | everything |
| **P1. Protocol TS client** | `schemas/plugin-host-protocol/<v>/protocol-client.ts` generated from the committed schema; `check:plugin-host-protocol-client` in `build` (byte-compare, a standalone compile of the client, and a separate host-equality compile of the type assertions); parity test against the goldens | — | M1, S1, P2, P3 |
| **M1. Mirror alias rule** — **done (#2591, `9c56ec148`)** | `plugin-host-protocol-mirror.mjs`: the newest-published alias rule enforced with a candidate open; promotion helper picks the maximum published version; tests for both promotion orders | — | P1, S1, P2, P3; **prerequisite of Lease's E2 and of E2′ item 3** |
| **S1. Protocol-session seam** | `openPluginProtocolSession` extracted from the factory with an **explicit, pre-bound dispatch table** as its authority; a non-destructive validation channel (MCP requests, an unknown-method probe, the stop hook alone, stdin close with an observed exit) separate from the destructive `teardown`; the one producer of MCP request metadata in the transport and the goldens regenerated with it; `OutOfProcessPluginSpec.connect` deleted and its 28 consumer sites migrated; the observation-only `observeChild` seam on the production factory; the validation-only entry `openValidationSession` and the validation host (base-envelope authority) under `src/plugins/validate/`; the four goldens made self-contained; a type-level and an import-boundary gate | — | P1, M1 |
| **P2. Validate CLI** | `src/plugins/validate/` (report library, source-drift scan, CLI entry, raw-stdout and stdin-close checks over the S1 channel), including the `process` arm over P3's `resolveProcessLaunch`; `plugin:validate` script with the source-mode child loader; the bundle-loads-in-bare-Node test with the post-wave recipe | S1; merges after P3 | P1, M1, P3 (development) |
| **P3. `process` entry runtime** | manifest schema tightening, the exclusive public type (`EntryPluginManifest \| ProcessPluginManifest`) and the generator rule that projects it, hardening (paths, reserved environment names, `minAppVersion ≥ 0.13.0`), `resolveBundledArgv` policy `"process"`, launch union in the factory with the wrap-internal environment, `process-entry-unconfined`, the **provenance gate in `importPluginFactoryForLifecycle` on all four activation paths** with `verified.rung` and a stated error precedence, routing by manifest shape, the seven slice-C sites moved to the two replacement codes, the `PluginManifest` wire change with schema, candidate and client regenerated, the Linux confinement CI job | S1; merges after P1 | P1, M1, P2 (development) |
| **P4. `process` admission in the marketplace** | `process-entry-requires-pinned-artifact` at the ladder, `gitInstallManifestMismatches` with the extended `ExpectedPlugin` (`platforms`, declared pins, the version floor), direct and local install, the zip transaction; per-version checker rules for the official repository | P3 | P5 |
| **P5. Cross-language smoke** | Python fixture plugin with a `process` entry that rejects a request without the MCP metadata, its golden transcript over real pipes through `openValidationSession` with the measurement field canonicalised, the real-confined-child run on macOS and Linux through `observeChild` with a supported Python provisioned (uv ensured, one install directory, managed-only discovery) and verified, a launcher import-origin test, stdin-close and raw-stdout checks, child-tree RSS and startup recorded | P3, P2 | P4 (development) |
| **E1′. Release PR** | changelog, schema and client regenerated at the final commit, `2/v0.13.0` candidate refreshed (the version is already `0.13.0` since #2589) | P1-P5, M1, S1 merged | — |
| **E2′. Post-tag runbook** | the official repository (after the candidate wave) and the portal and repository plugins vendor the client, the CLI bundle and the child-main bundle from tag `v0.13.0` with build-capable vendoring; drift scripts retired; mirror promotion of `2/v0.13.0` under M1's rule | tag `v0.13.0`; M1; the candidate wave merged in the official repository | — |

**Merge order — one, fixed:** P0 → S1 → P1 → M1 → P3 → P2 → P4 → P5 → E1′ → tag →
E2′. Development is parallel where the "May run beside" column says (separate
checkouts, each written against `main` after S1); **merging** is serial in exactly this
order, and for every shared file the rule is one rule: the later slice in this order
rebases onto `main` after the earlier one merges and integrates on its own side. The
order is chosen so that no slice carries a conditional: P1 precedes P3, so P3 always
regenerates the client; P3 precedes P2, so P2 adds the CLI's `process` arm itself (the
second round's "whichever of P2 and P3 merges second" rule is withdrawn); P2 precedes
P5, whose fixture the CLI probes. M1 touches only the mirror scripts; it is **done**
(#2591, `9c56ec148`), so the remaining order is S1 → P1 → P3 → P2 → P4 → P5 →
E1′, and both promotions it guards are unblocked. Each PR has
`main` as its base branch (never a sibling slice), so a merged branch's deletion cannot
close it.

##### Shared files, ownership and integration order

The leader integrates. Every shared file follows the one merge order above: the later
slice rebases onto `main` after the earlier one merges and resolves the conflict on its
own side. The third column is that order restricted to the file:

| File | Slices that change it | Order |
|---|---|---|
| `package.json` scripts | P1 (`generate:`/`check:plugin-host-protocol-client`, the `build` chain), P2 (`plugin:validate`) | P1 → P2 |
| `src/__tests__/packaging-discipline-source.test.ts` | P1 only | — |
| `scripts/lib/plugin-host-protocol-mirror.mjs`, `scripts/sync-plugin-host-protocol-mirror.mjs`, `test/scripts/plugin-host-protocol-mirror.test.ts` | M1 only | — |
| `src/plugins/isolation/out-of-process-plugin.ts` | S1 (extract the session and the table binding, delete `connect`, add `observeChild`), P3 (launch union, admission check, wrap-internal environment) | S1 → P3 |
| `src/plugins/isolation/plugin-protocol-session.ts`, `bound-host-api-table.ts` (new) | S1 creates; P3 adds the `entryPath` semantics for a process launch | S1 → P3 |
| `src/plugins/isolation/plugin-child-transport.ts` | S1 only (the instance/MCP request split, the metadata producer, the probe) | — |
| `src/plugins/validate/validation-host.ts`, `validation-session.ts` (new) | S1 only; P2 and P5 consume and add no export S1 did not define | — |
| `scripts/lib/plugin-isolation-type-assertions.ts` (new) | S1 creates; P3 replaces `entryPath` with `launch` in the `OutOfProcessPluginSpec` key set | S1 → P3 |
| `out-of-process-plugin.test.ts`, `child-process-config-wire.test.ts`, `plugin-protocol-session.test.ts` (new), `plugin-child-transport.test.ts` (new) | S1 (the `connect` migration; the session and transport cases), P3 (recorded spawn-spec cases for a process launch) | S1 → P3 |
| `host-protocol-golden-host.ts` (moved), `host-protocol-golden.test.ts`, `host-protocol-schema-parity.test.ts`, the `2/plugins/*` fixtures and transcripts | S1 (host moved, fixtures self-contained, transcripts regenerated with the request metadata), P3 (process-launch construct golden; the exclusive-manifest negatives), P5 (Python golden) | S1 → P3 → P5 |
| `confined-plugin-child.test.ts` | S1 (`:1858`, `:1920` move to `observeChild`; the `createGoldenHost` import), P3 (process launch, environment negatives), P5 (smoke, stdin-close, stdout, measurement) | S1 → P3 → P5 |
| `.github/workflows/ci.yml` | P3 (the Linux confinement job), P5 (uv and Python provisioning in `build-and-test` and both confinement jobs) | P3 → P5 |
| `schemas/plugin-host-protocol/2/protocol.schema.json`, `web/public/schemas/…/2/v0.13.0/`, `mirror.json`, `…/2/protocol-client.ts` | P1 (creates the client), P3 (regenerates all three) | P1 → P3 |
| `scripts/lib/plugin-host-protocol-schema.ts` | P3 only (the excluded-property rule) | — |
| `schemas/plugin-manifest.schema.json`, `src/plugins/public-contract.ts`, `src/plugins/runtime/index.ts`, `process-entry.ts`, the closed code sets, both locale catalogs, `format-ipc-error.ts`, `labels.ts`, `PluginConfigTab.tsx` | P3 only | P4 consumes the codes P3 defines and touches none of these |
| `src/marketplace/**`, `src/plugins/marketplace.ts` and their tests | P3 (the mechanical code rename at the seven sites, refusal still unconditional), P4 (the admission logic) | P3 → P4 |
| `docs/guides/plugin-development.md` | P1 ("HostApi Boundaries"), P3 ("Manifest Basics"), P2 ("Testing Checklist") | P1 → P3 → P2 |
| `knip.jsonc` | S1 (the type-assertions entry), P1 (the client-assertions entry and the client entry), P2 (`cli.ts` entry, the raw-fixture glob) | S1 → P1 → P2 |
| `src/plugins/validate/validate-plugin.ts` | P2 only, with both arms | — |

**The interface S1 freezes**, which P2, P3 and P5 are written against and which none of
them may change (P3 may only **add** the launch kind that decides `entryPath`, and the
`launch` member of `OutOfProcessPluginSpec`, which **replaces** its top-level `entryPath`;
construct's `entryPath` is derived from the launch):

- `createBoundHostApiDispatchTable(hostApi, confinement, onMalformedCredentialSelector?)`,
  its `hostApi` parameter type `DispatchableHostApi` and its branded result
  `BoundHostApiDispatchTable`, in `bound-host-api-table.ts`;
- `openPluginProtocolSession(spec)`, `PluginProtocolSessionSpec` (with the required
  `table` and the optional `signal`, which the opener honours from its first line),
  `PluginProtocolSession` (`instance`, `capabilities`, `construction`,
  `channel`, `teardown`) and `PluginProtocolChannel` (`requestMcp`, `probe`,
  `runStopHook`, `closeInput`, `exited`);
- `PluginChildTransport.request` (instance methods only), `requestMcp` with its method
  type `PluginMcpRequestMethod`, `probe` with its reply type `PluginChildProbeReply`, the
  metadata producer `pluginChildRequestMeta()`, and the split of an observed exit
  (`peerGone`, non-destructive) from a requested termination (`close`) and a live
  child's fault (`fault`: starts the one termination sequence if none is active, else
  records only), with `link.terminate` called at most once per transport;
- `ChildLink` with `onGone` terminal-only and the required `onFault`;
- `OutOfProcessPluginSpec` without `connect` and with `observeChild`,
  `ObservedPluginChild` (`pid`, `onStdout`, `endInput`, `exited`), and the admission
  check `connectionHostProtocol(manifest)`, exported for the validation session;
- `openValidationSession(input)` with its input type `ValidationSessionInput` (with the
  same optional `signal`), `ValidationSession`, `createValidationHost(overrides?)` with
  its `ValidationHostOverrides` parameter and `ValidationHost` result, and
  `validationConfinement(pluginId, pluginRoot, pluginDataDir)`.

The modules S1 creates export nothing beyond this list, and the modules it changes add
no export beyond it.

##### P1. The protocol TS client

*Files.*

- `scripts/lib/plugin-host-protocol-client.ts` (new): reads the **committed**
  `schemas/plugin-host-protocol/<v>/protocol.schema.json` for the one served version
  (`HOST_PROTOCOL_VERSIONS_SERVED`, `host-api-wire.ts:56`) — the file, not the TS
  sources, so the client is provably a projection of the published artifact and any
  language could do the same — and emits `schemas/plugin-host-protocol/<v>/protocol-client.ts`:
  the `$defs.types` and every method's `params`/`result` compiled with
  `json-schema-to-typescript` (fact 3; `bannerComment` replaced by the generator's own
  header, `strictIndexSignatures`, `additionalProperties: false`), then a generated stub
  section: `export const HOST_PROTOCOL_VERSION = "<v>"`, the `HostMethod`,
  `InstanceMethod`, `HostNotification` and `HostProtocolErrorCode` unions from
  `$defs.methods`, `$defs.notifications` and `$defs.errorCodes`, a
  `HostClientTransport { request(method, params): Promise<unknown>; notify(method, params): void }`
  interface the author implements over their own stream, and `createHostClient(transport)`
  with one typed method per `ave/host/*` entry (named by the method's path segments,
  `storage/read` → `storage.read`) plus `isHostNotification(frame)`. The file imports
  nothing and embeds **no app version** (decision 28): its header names the protocol
  version and the generator; a plugin repository pins it by sha256 from the tag like the
  schema. Output is key-sorted and LF-normalised the way the schema generator's is
  (`plugin-host-protocol-schema.ts:265-285`), so it is byte-stable across platforms.
- `scripts/generate-plugin-host-protocol-client.ts` (new): the command line, the shape of
  `generate-plugin-host-protocol-schema.ts:1-63` (write, or `--check` and byte-compare
  with CRLF tolerance, `:46-52`; one outcome line; no entry-module guard). In `--check`
  mode it **also compiles, in two separate programs**, because one invocation cannot
  serve both: TypeScript 7 refuses file operands beside the root `tsconfig.json` (TS5112,
  "tsconfig.json is present but will not be loaded if files are specified"), and the
  host modules the equalities import need the repository's `lib` (ES2023, DOM) and
  `skipLibCheck` (`tsconfig.json:10`, `:14-16`), which an isolated invocation discards
  (reproduced read-only by the host re-review, 2026-09-28: `findLastIndex` at
  `src/shared/shell-analysis.ts:79` and dependency declarations fail under ES2022).
  1. **Standalone**: `tsc -p scripts/tsconfig.plugin-host-protocol-client.json` (new):
     `files: ["../schemas/plugin-host-protocol/2/protocol-client.ts"]`, `strict`,
     `noEmit`, `target: es2022`, `module: esnext`, `moduleResolution: bundler`,
     `lib: ["es2022"]`, `types: []` — no ambient type, no DOM, no Node, so a compile proves
     the generated file stands alone with no import (fact 3's invocation, as a project).
     A `-p` project with `files` is not a file operand, so TS5112 does not apply (checked
     with the repository's `tsc` 7.0.2 on 2026-10-01 in a scratch directory: a clean file
     exits 0, one with an unresolved import exits 1 with TS2307).
  2. **Host equality**: `tsc -p scripts/tsconfig.plugin-host-protocol-client-assertions.json`
     (new): `extends: "../tsconfig.json"`, `include: []`, `files:
     ["lib/plugin-host-protocol-client-assertions.ts"]`, `compilerOptions: { noEmit: true,
     incremental: false }` — the repository's own `lib`, `types` and `skipLibCheck`, over
     `scripts/lib/plugin-host-protocol-client-assertions.ts` (new), a types-only module
     that imports the generated file (a `.js` specifier, as `NodeNext` resolves it) and the
     host's constants and holds compile-time equalities: `HostProtocolErrorCode` ≡
     `typeof HOST_API_WIRE_ERROR_CODES[number]` (`host-api-wire.ts:545`), `InstanceMethod`
     ≡ the values of `PLUGIN_INSTANCE_METHODS` (`plugin-instance-wire.ts:31`),
     `HOST_PROTOCOL_VERSION` ≡ `HostProtocolVersion` (`host-api-wire.ts:59`), each an
     exported mutual-assignability `type Equal<A, B>` alias (exported so `noUnusedLocals`,
     `tsconfig.json:8`, does not flag it) that fails to compile when either side gains or
     loses a member. The same file is also inside `bun run typecheck` (the root
     `include` has `scripts`, fact 12; CI runs it at `.github/workflows/ci.yml:86`), so
     the equality holds on every push even where `build` is not run.
  A runtime comparison cannot do either — the unions are erased — which is why the first
  round's "the test imports it" gate was no gate.
- `package.json`: `generate:plugin-host-protocol-client`,
  `check:plugin-host-protocol-client`; `build` (`:47`) gains the check **after**
  `check:plugin-host-protocol-mirror`, so the chain is schema → mirror → client and a
  stale or non-compiling client is caught by the same gate that catches a stale schema;
  `release.mjs:112` gains the regenerate call after the schema's.
  `json-schema-to-typescript` `15.0.4` exact-pinned in `devDependencies`.
- `src/__tests__/packaging-discipline-source.test.ts:679-692` and `:705-712`: the
  assertion lists gain the new check in position; `:715-722` gains the `release.mjs`
  line.
- `knip.jsonc`: `scripts/lib/plugin-host-protocol-client-assertions.ts` joins `entry`
  with its reason (compiled by the check's second program and by `typecheck`; nothing
  imports it); the script is named by `package.json`. The generated
  `schemas/plugin-host-protocol/*/protocol-client.ts` is an `entry` too: it is the
  published API surface plugin repositories vendor, so its exports are not debt, and
  without the entry knip reports each exported type the parity test and the
  assertions module leave unused (148 at this commit) against a fixed baseline.
- `docs/guides/plugin-development.md` ("HostApi Boundaries", `:60`): a paragraph on the
  client and how a JS author who does not use the reference runtime pairs it with their
  own stdio loop.

*Tests (revert-to-fail target in parentheses).*

- `src/plugins/isolation/__tests__/host-protocol-client-parity.test.ts` (new):
  regenerating produces the committed bytes on this platform (a byte in the committed
  file); `createHostClient` exposes exactly one method per `$defs.methods` `ave/host/*`
  entry and nothing else, read from the schema, not from a list in the test (delete an
  entry from the stub emitter); for every golden `methods/<method>.json`
  (`fixtures/host-protocol/2/methods/`, walked with `goldenFiles`,
  `host-protocol-golden-host.ts:283`), calling the stub with the golden `params` through
  a recording transport yields the golden frame's `method` and `params` (change the
  path→property mapping).
- The compile gate, demonstrated in `test/scripts/protocol-client-check.test.ts` (new),
  which runs each program against a temporary copy: the generated file with one injected
  type error fails the standalone program; the generated file with an added `import`
  fails it (the file must stand alone); the assertions module with one error code dropped
  from its side of the union fails the host-equality program while the standalone one
  still passes (the two programs gate different things); the committed pair passes both
  (each case is its own revert target).

*Gates.* `bun run typecheck`; `bun run check:plugin-host-protocol-client`; `bun run
test:vitest -- run src/plugins/isolation src/__tests__/packaging-discipline-source.test.ts
test/scripts/protocol-client-check.test.ts`; `bun run build` (carries the new check);
`check:knip:engine` against its baseline (`knip.jsonc:13`); naming gate; CI
`build-and-test` and `naming-gate` green on the rollup.

*Lock suites.* `packaging-discipline-source` **changes** (the two assertion lists and the
release-helper assertion). `channel-inventory`, `host-renderer-only-channels`,
`domain-exports`, `preload-shape`, `settings-store` **unchanged** — a generated file and
a build check add no channel, bridge method, domain export or setting.

##### M1. The mirror alias rule

**Status: done (#2591, `9c56ec148`)** — merged on 2026-10-01 (`7df8a0133`), and it
implements this slice as written — the rule without the candidate guard, `--publish
<protocol>/<version>` refusing malformed, unrecorded and already-published targets, and
both promotion orders under test; `docs/development/release-process.md` names the
`--publish` command (`:108-114`, `:126-127`), and §6.1, §9.5 step 6 and the §9.6 E2 row
carry the newest-published rule. The anchors in this subsection are `c73f59580`'s,
before it; the text is kept as the specification that change was reviewed against, and
fact 5 cites the result at `9c56ec148`.

*Files.*

- `scripts/lib/plugin-host-protocol-mirror.mjs:102-118`: the loop over published
  protocols splits. The alias rule — `aliases[protocol]` equals the `publishedTag` of the
  copy with the highest `appVersion` among that protocol's **published** copies — runs
  for every protocol with at least one published copy, **whether or not a candidate is
  open** (the `continue` at `:107` no longer guards it). Only the second rule, "the
  canonical file equals the newest published copy" (`:113-118`), stays candidate-gated,
  because with a candidate open the canonical file is the candidate by definition
  (`:73-79`). The failure text stays `<protocol> alias must name the latest published
  copy`.
- `scripts/sync-plugin-host-protocol-mirror.mjs` (the promotion side; `syncProtocolMirror`
  `:154-163`): a `--publish <protocol>/<version>` mode sets that copy's `publishedTag`
  and rewrites `aliases[protocol]` to the maximum published version, writing
  `<protocol>/protocol.schema.json` from that copy — so promoting an older copy leaves a
  newer alias where it is, and promoting the newest moves it. `docs/development/release-process.md`
  names the command in its promotion step.
- `docs/design/plugin-hostapi-protocol.md` §6.1, §9.5 step 6, §9.6 E2 row: the rule
  above replaces "moves the alias to that entry in the same commit" (done in P0).

*Tests.* `test/scripts/plugin-host-protocol-mirror.test.ts` (existing): with `2/v0.12.0`
and `2/v0.13.0` both published and a `2/v0.14.0` candidate open, an alias naming
`v0.12.0` **fails** and one naming `v0.13.0` passes (revert: restore the `continue`
guard); promotion order A — publish `0.13.0` first, alias `v0.13.0`, then publish
`0.12.0`: the alias is unchanged and the check passes; order B — publish `0.12.0` first,
alias `v0.12.0`, with `0.13.0` still a candidate: passes; then publish `0.13.0`: the alias
must move to `v0.13.0` and a manifest that left it fails (revert: make `--publish` set the
alias to the promoted copy); an alias naming a candidate or an orphan still fails
(`:88-93`, unchanged).

*Gates.* `bun run check:plugin-host-protocol-mirror` on the committed tree (three copies,
one alias, one candidate, unchanged); `bun run test:vitest -- run
test/scripts/plugin-host-protocol-mirror.test.ts src/__tests__/packaging-discipline-source.test.ts`;
`bun run build`; naming gate; CI rollup.

*Lock suites.* All six **unchanged**: no script is added or renamed (`packaging-discipline-source`
names `check:plugin-host-protocol-mirror`, which keeps its name).

##### S1. The protocol-session seam

The layer between "a child exists on a link" and "a `RuntimePlugin` the lifecycle can
call" is today the second half of the factory body (fact 12). S1 names it, so that the
production factory owns admission and confined spawning **without a bypass**, and the
validator and the conformance tests own their own transport **without the factory**.
The third round fixed four gaps in the second round's interface, all frozen here before
P2, P3 and P5 fan out: the session's **authority** is an explicit input, never something
it derives; validation **requests and lifecycle controls** are separate from the
destructive teardown; the production child has an **observation-only** test seam; and
every consumer the deletion of `connect` breaks is **migrated in S1** (fact 15).

*Files.*

- `src/plugins/isolation/bound-host-api-table.ts` (new): `createBoundHostApiDispatchTable`
  moves here from `out-of-process-plugin.ts:155-173`, unchanged in behaviour (fact 13),
  and returns `BoundHostApiDispatchTable` — `Record<HostApiPath, HostApiPathHandler>`
  branded with a module-private `unique symbol` that holds the `confinement` it was bound
  to, so a value of that type can come only from this function and says which envelope it
  enforces. `hostProtocolCapabilities` (`host-api-dispatcher.ts:210-216`) reads string
  keys only and is unaffected by the symbol. The module imports only
  `host-api-dispatcher.ts` and `host-api-wire.ts`, so the session module can take the
  type without importing the factory (no cycle for `check:import-cycles`). Its three
  importers move to it and nothing re-exports it from the old place.
- `src/plugins/isolation/plugin-protocol-session.ts` (new; owner: the isolation
  directory, i.e. P3's engineer):
  `openPluginProtocolSession(spec): Promise<PluginProtocolSession>` with
  - `PluginProtocolSessionSpec = { pluginId, manifest, hostProtocolVersion, link:
    ChildLink, context: PluginRuntimeContext, entryPath, table:
    BoundHostApiDispatchTable, auditLog?, onClosed(reason): Promise<void>, signal?:
    AbortSignal }`. **`table` is required and is the session's whole authority**: the
    session serves exactly that table, advertises `hostProtocolCapabilities(spec.table)`
    in construct, and never derives, widens or defaults an envelope — it imports nothing
    from `permissions/`, does not import `derivePluginChildEnvelope`, spawns nothing and
    reads no sandbox state. `onMalformedCredentialSelector` leaves the spec, because it
    is an input of the table binding, where the factory passes it today
    (`out-of-process-plugin.ts:1198-1203`).
  - `PluginProtocolSession = { instance: RuntimePlugin; capabilities: readonly string[];
    construction: PluginConstructResult; channel: PluginProtocolChannel;
    teardown(reason: string): Promise<void> }`. `teardown` is the **only destructive
    operation**: `live = false`, the host watchers end, `transport.close` (and so
    `link.terminate`, fact 14), then `onClosed`; it is idempotent. **A natural exit is
    not a teardown**: when the link reports the child gone (`onGone`), the session runs
    its non-destructive release — `live = false`, the host watchers end, the transport's
    `peerGone` (below: pending calls rejected with the exit reason, dispatcher state
    released, **no** `terminate`), then `onClosed` — exactly once. A later `teardown`
    after that release terminates nothing, because the transport is already closed by
    the peer, and only makes `onClosed`'s once-guard visible. Deadlines, framing
    failures and **link faults** remain destructive: a request deadline
    (`plugin-child-transport.ts:175-180`), a fatal stream error (`:137`) and a fault the
    link reports on a live child (below; host re-review #28) reach `transport.close`,
    and so `link.terminate`, and the session's release follows from the resulting exit.
    **Cancellation exists before construction completes** (host re-review #29): when
    `spec.signal` is given, the session listens from its first line — before the
    transport starts and before construct is written — until its release. Aborting runs
    `teardown` with the signal's reason at any point, including while construct is
    pending: the pending construct rejects (the transport closed), the opener rejects
    with the abort reason instead of waiting for construct's own deadline, and the link
    is terminated once. A construct reply that arrives after the abort is dropped with
    the closed channel, and the opener re-checks `signal.aborted` after construct
    resolves and before returning, so a success racing the abort is torn down and never
    returned. An already-aborted signal tears down before any frame is written.
    Production passes no signal — the runtime's factory timeout already disposes a late
    instance (`runtime/index.ts:1209-1227`) — and the validation CLI always passes one.
    `instance.stop` keeps today's production behaviour exactly (the stop hook bounded by
    `pluginStartupDefaultMs`, then termination, `:1496-1524`) by being
    `channel.runStopHook()` followed by `teardown(...)`.
  - `PluginProtocolChannel = { requestMcp(method, params, timeoutMs?): Promise<unknown>;
    probe(method, params?): Promise<{ result } | { error }>; runStopHook(): Promise<void>;
    closeInput(): void; exited: Promise<string> }` — **non-destructive** controls:
    `requestMcp` is the transport's (below), for `server/discover`, `tools/list`,
    `tools/call` and `resources/read`; `probe` sends one request verbatim for the
    unknown-method check; `runStopHook` sends `ave/instance/stop` when the construction
    declared it and does not close, flip `live` or terminate; `closeInput` is
    `link.output.end()` and nothing else; `exited` settles with the reason the link's
    `onGone` reports, **and on nothing else**: a fault, a deadline, an abort or a
    `teardown` does not settle it; each ends the child, and `exited` settles when that
    child's exit is then observed.

  The body is the factory's from the transport (`:1205`) to the returned proxy
  (`:1544`): `PluginChildTransport` over the link and the table, the host watchers, the
  construct request (`:1436-1446`), `requireServedCapabilities` (`:1107-1123`), the seed
  re-push, the tool/UI/lifecycle proxy and the startup-failure teardown
  (`abandonChild`, `:1289-1295`, which becomes `teardown`).
- `src/plugins/isolation/plugin-child-transport.ts` — **the one producer of MCP request
  metadata on the plugin-child channel** (fact 16):
  - `request(method: PluginInstanceMethod, params, timeoutMs?)` accepts only the values
    of `PLUGIN_INSTANCE_METHODS` and sends params verbatim; any other method throws (an
    internal contract violation, not a fallback).
  - `requestMcp(method: PluginMcpRequestMethod, params, timeoutMs?)`, with
    `PluginMcpRequestMethod = "server/discover" | "tools/list" | "tools/call" |
    "resources/read"`, sends `{ ...params, _meta: pluginChildRequestMeta() }`, where
    `pluginChildRequestMeta()` returns `{ [META_PROTOCOL_VERSION]: MCP_PROTOCOL_VERSION,
    [META_CLIENT_CAPABILITIES]: {} }` (`protocol-constants.ts:18`, `:41-43`). A
    caller-supplied `_meta` is refused, because no caller sets one and a merge would make
    the producer's keys overridable. `clientCapabilities` is `{}` because the host serves
    no server-to-client MCP request on these pipes (`plugin-child-transport.ts:242-247`);
    declaring elicitation there, as the in-process loopback does for its own channel
    (`plugin-mcp-host.ts:310-320`, unchanged), would promise a surface this channel does
    not have. `clientInfo` is deliberately omitted — the specification's SHOULD allows
    "unless specifically configured not to", it is self-reported and must not change
    behaviour (fact 16), the child already learns the host's protocol in construct, and an
    app version in every `tools/call` frame would change every golden at each release bump
    and make the validator's transcript depend on the app build.
  - `probe(method, params)` sends one request verbatim and resolves with the reply's
    `result` or `error` instead of throwing; it refuses a `PluginInstanceMethod` or a
    `PluginMcpRequestMethod`, so it cannot become a third path for either.
  - **Observed exit is split from requested termination** (host re-review #25,
    cross-language re-review round 3, finding 1). `start()` registers
    `link.onGone((reason) => this.peerGone(reason))` instead of `this.close(reason)`
    (`:154-156`). `peerGone` sets `closedReason`, rejects every pending call with the
    exit reason and calls `dispatcher.childGone()` — everything `close` does
    (`:203-218`) except `link.terminate`, which has nothing left to end. `close` keeps
    its callers and its meaning, "the host ends the child": the request deadline, the
    fatal-stream callback and the session's `teardown`. Both are idempotent against each
    other through `closedReason` for the rejection and `childGone` part, so whichever
    happens first decides whether a termination was ever requested; an observed exit is
    recorded even after `close` (it is what settles the session's `exited`).
  - **`onGone` is terminal-only, and a live child's fault has its own path** (host
    re-review #28). `ChildLink.onGone` is documented and implemented as "the child no
    longer exists": the process's `exit`, or an `error` from a spawn that produced no
    process (`child.pid` not a positive number). Node also emits `error` when a signal
    could not be delivered to a process that is still running
    (<https://nodejs.org/api/child_process.html#event-error>, checked 2026-10-01), which
    `managed-child-processes.ts:109-113` already refuses to treat as termination. Such
    an `error` goes to a new required member, `ChildLink.onFault(handler: (reason) =>
    void)`, and the transport's `start()` registers `link.onFault((reason) =>
    this.fault(reason))`. **The transport owns at most one termination sequence**
    (cross-language re-review round 5): `ChildLink.terminate` starts the link's whole
    sequence — production's is `terminateChildProcess(child, 3_000)`, SIGTERM and then
    one SIGKILL after the grace period if no exit was seen
    (`out-of-process-plugin.ts:968-971`, `terminate-child-process.ts:12-34`) — and the
    transport calls it **at most once in its lifetime**, guarded by a `terminating` flag
    kept apart from `closedReason` (a `peerGone` sets `closedReason` and never
    `terminating`). `close` sets `closedReason` and `terminating` **before** it calls
    `link.terminate`, because Node emits the `error` of a refused `kill()` (`EPERM`)
    synchronously, inside the call (`ChildProcess.prototype.kill`,
    <https://github.com/nodejs/node/blob/31c6e70759bae3cb5d1af77a4dc1a3fd1726a244/lib/internal/child_process.js#L493-L518>,
    the `v24.9.0` tag's commit, where the refused-signal `emit('error')` is `:511-512`,
    checked 2026-10-01): that fault re-enters the transport while `terminate` is still
    on the stack. `fault` is then: after an observed exit, nothing; with no sequence
    active (and so no `closedReason` either), `close(reason)`, which starts it; with a
    sequence active, **record only** — the reason is appended to the transport's
    `terminationFaults` and logged at `warn` with the plugin id, and no `terminate` is
    called and no timer armed. The sequence's own escalation is the retry: a refused
    SIGTERM is followed by the link's SIGKILL after the grace period. If SIGKILL is
    refused too, its fault is recorded the same way and nothing further happens:
    `exited` stays unsettled, no signal is retried, and the owner sees an unexited child
    through its own bound — the CLI's link records the same faults itself and its
    always-reported `protocol.teardown` row fails with them (P2), production's `stop` is
    left awaiting the exit as today, whose helper also makes exactly one SIGKILL attempt
    (`terminate-child-process.ts:22-30`) — and through the `warn` diagnostic. The
    production adapter (`out-of-process-plugin.ts:973-982`) and the plain adapter
    `child-process-config-wire.test.ts:218-222` (and the validate CLI's link, P2) both
    stop forwarding every `error` to `onGone`: `exit` → `onGone`; `error` with no pid →
    `onGone`; `error` with a pid → `onFault`. In-memory links have no process to fault
    and implement `onFault` as a registration that never fires.

  `ave/instance/*` and `ave/host/*` frames carry no MCP `_meta`: they are Ave methods
  (§3), and the metadata rule is MCP's. The factory's `tools/call` and `resources/read`
  (`out-of-process-plugin.ts:1472-1480`, `:1542`, now in the session) go through
  `requestMcp`; construct, start, `onPublished`, stop and shutdown through `request`.
- `src/plugins/isolation/out-of-process-plugin.ts`:
  - `OutOfProcessPluginSpec.connect` (`:998-1001`) is **deleted**, and
    `createBoundHostApiDispatchTable` moves out (above).
  - `ConfinedPluginChild` (`:748-751`) gains `pid: number | undefined`, which
    `spawnConfinedPluginChild` fills from the spawned wrapper (`:963-985`).
  - `observeChild?: (child: ObservedPluginChild) => void` joins the spec, with
    `ObservedPluginChild = { readonly pid: number | undefined; onStdout(listener: (chunk:
    Buffer) => void): void; endInput(): void; readonly exited: Promise<string> }`. The
    factory calls it once, **after** `spawnConfinedPluginChild` has returned a wrapped
    child and the grant re-check (`:1186`) has passed, and **before** the session starts
    the transport, so a listener sees every byte. It can read stdout bytes (a `data`
    listener beside the transport's, exactly what the confined suite attaches today,
    `confined-plugin-child.test.ts:1922-1924`), read the wrapper's PID, observe exit, and
    end stdin — the host crash the stdin-close rule is about, as `link.output.end()` does
    today (`:1870`). By construction it cannot supply, replace or re-spawn the child, see
    or change the envelope, the spawn spec, the table or the registration, write a frame,
    or terminate. It observes the production child after the wrap, so it weakens no
    confinement; no runtime caller passes it (the boundary test below).
  - The factory body is: admission (`connectionHostProtocol`, `:1156`, exported for the
    validation session) → `envelope` (`:1161-1174`) → registration → `spawnConfinedPluginChild`
    with that `envelope` → `observeChild?.(…)` → `table = createBoundHostApiDispatchTable(
    hostApi, envelope, onMalformed)` — **the same `envelope` value the spawn received**,
    as today (`:1198-1203`) → `openPluginProtocolSession({ …, link: child.link, table,
    onClosed: async () => { await child.waitForExit?.(); registration?.dispose(); } })` →
    `return session.instance`. The channel and `teardown` are not reachable from the
    returned `RuntimePlugin`, and there is no second way to obtain a child.
    `childEntryPath` stays injectable (`:1003`, `:738`): it is the path the **confined**
    spawn runs, which is how the confined suite serves the invoker module under the real
    wrap, and it bypasses nothing.
- `src/plugins/validate/validation-host.ts` (new; production path, behaviour-named):
  `createGoldenHost` (`host-protocol-golden-host.ts:79`) moves here as
  `createValidationHost(overrides?)` — a host that serves the **real** dispatch table
  with recording handlers; the worker double at `:95` and `:175` becomes
  `scriptedWorker`, and every `mock`/`fake` identifier in the moved code is renamed for
  what it does, which keeps the file inside the naming gate without a `Why` header
  (fact 12). `goldenFiles` (`:283`) stays in `__tests__`. Its `getInstalledPluginIds`
  default is `[]` (the member excludes the caller, and a validated plugin is validated
  alone); the recorded neighbourhood the goldens pin is supplied through `overrides` by
  a `__tests__` helper, so no recorded plugin id lands in the production host. Its
  roots are synthetic and outside the vendor embedded-path rule (`/validation/user`,
  `vendor.mjs:37-43`), because the CLI bundle carries them (P2). The file also defines **the
  validation host's authority**, `validationConfinement(pluginId, pluginRoot,
  pluginDataDir)` = `derivePluginChildEnvelope({ pluginId, pluginRoot, pluginDataDir,
  configValue })` **with no `sandbox` input** — the base envelope of fact 13 and nothing
  else: no `hostDirectory` grant and no `userChosenDirectory` grant, because the validator
  has no user approvals to consult and must not read `~/.ave/config/settings.json`. A delegated
  worker the plugin asks for beyond its own root and data directory is therefore refused
  by the same `spawnWorker` check production applies, and a plugin that declares
  `sandbox` grants is validated under this narrower envelope, with the grants it did not
  apply reported `not exercised` (P2's `sandbox.grants` row), never as passed.
- `src/plugins/validate/validation-session.ts` (new; owner: the validate directory, i.e.
  P2's engineer): `openValidationSession({ manifest, host: ValidationHost, link:
  ChildLink, entryPath, pluginRoot, pluginDataDir, signal?: AbortSignal }):
  Promise<ValidationSession>` refuses
  an undeclared or unserved protocol with `connectionHostProtocol` before writing any
  frame, binds `table = createBoundHostApiDispatchTable(host.api,
  validationConfinement(manifest.id, pluginRoot, pluginDataDir))`, builds the
  `PluginRuntimeContext` from the validation host and calls `openPluginProtocolSession`
  with the caller's `signal`;
  `ValidationSession` is the whole `PluginProtocolSession` (channel and `teardown`
  included) plus the `confinement` it was bound to. **This is the validation-only entry
  point.** Among production modules it is the only caller of `openPluginProtocolSession`
  besides the factory, and nothing under `src/plugins/runtime/`, `src/boot/` or
  `src/main/` imports anything under `src/plugins/validate/`.
- **Every consumer the deletion of `connect` forces** (fact 15), migrated in S1:
  1. `host-protocol-golden.test.ts`: `openSession` (`:186-215`) attaches the paired
     in-memory link (`:196-202`, the child end running `servePluginChild` as today) to
     `openValidationSession`; "refuses an old bundle before its child connects"
     (`:690-695`) calls `openValidationSession` with a link whose `output` fails the case
     on any write and expects the same `does not declare a host protocol` rejection; the
     `FIXTURE_CODE_ROOT` mapping (`:64-66`, `:700-707`) is deleted and each of the four
     protocol-2 fixtures (`portal`, `meeting`, `mail`, `assistant`) receives its
     own `entry.mjs`, moved from `fixtures/host-protocol/1/plugins/<id>/entry.mjs`, so
     every `2/plugins/<id>` directory is a complete plugin a directory validator can take
     as is (`1/` keeps its manifests, transcripts and `invoker.mjs`, from which
     `INVOKER_ENTRY` is still read, and its `meeting` and `local-indexer` entries become
     import traps that throw, so the old-bundle case proves refusal before import); the five
     `2/plugins/*/expected.jsonl` transcripts are regenerated, and the reviewed diff is
     exactly the two `_meta` keys on every `tools/call` and `resources/read` frame.
  2. `out-of-process-plugin.test.ts`, the 20 `connect` sites (`:291` to `:1031`): the
     cases that exercise the protocol once a child exists — "the pilot" (`:282`), "a child
     that dies" (`:460`), the config snapshot (`:555`), the framing limits (`:615`),
     construct negotiation after connection (`:873-952`), the `ui://` card (`:954`) and
     `onShutdown` (`:1008`) — call `openPluginProtocolSession` over the same paired link
     with a table bound by `createBoundHostApiDispatchTable(hostApi, envelope)` to a
     literal test envelope (the recorded `terminate` of `:668` and `:1031` stays on that
     link). The two cases that assert a refusal **before any spawn** (`:847`, `:860`)
     keep exercising the factory, with `vi.mock("../../../permissions/confined-child.js")`
     recording `spawnConfinedChild` calls and expecting none — a test double at the
     module where confinement begins, not a production seam.
  3. `child-process-config-wire.test.ts:356`, `:438`, `:510`, `:562`: the unconfined
     child `connectPlainChild` spawns (`:198-226`, renamed `spawnPlainChild`) attaches to
     `openPluginProtocolSession` with a table bound to `derivePluginChildEnvelope` over the
     case's own roots — the derivation production uses — because these cases prove
     config marshalling across a real process, not confinement.
  4. `confined-plugin-child.test.ts:1858`, `:1920`: the factory is called without
     `connect` and with `observeChild`; the stdin-close case calls `endInput()` and races
     `exited` against 5 s, and the stdout case collects `onStdout` bytes. The spawn they
     exercise is now the production factory's own, not a wrapper around it.
  5. `createGoldenHost`'s importers (`host-protocol-schema-parity.test.ts`,
     `confined-plugin-child.test.ts`, `host-protocol-golden.test.ts`) import
     `createValidationHost`; `createBoundHostApiDispatchTable`'s
     (`out-of-process-plugin.test.ts`, `host-protocol-schema-parity.test.ts`) import it
     from `bound-host-api-table.ts`.
  6. Every `ChildLink` literal gains `onFault` (host re-review #28): the in-memory links
     at `out-of-process-plugin.test.ts:224` and `:833`,
     `child-stream-multiplex.test.ts:85` and `host-protocol-golden.test.ts:201` register
     a handler that never fires; the process links (production `:973-982`,
     `spawnPlainChild` at `child-process-config-wire.test.ts:218-222`) split `error` by
     pid as above. The member is required, so `typecheck` finds a production link that
     was missed and `check:typecheck-tests` (`package.json:84`) a test link.
- `scripts/lib/plugin-isolation-type-assertions.ts` (new; types-only, inside the root
  `include`, so `bun run typecheck` and CI `.github/workflows/ci.yml:86` enforce it):
  `Equal<keyof OutOfProcessPluginSpec, "manifest" | "auditLog" | "entryPath" |
  "childEntryPath" | "registerSandboxEnvelope" | "onMalformedCredentialSelector" |
  "observeChild">` — an exact key set, so restoring `connect` or adding any member fails
  `typecheck` until the set is edited in review (P3 replaces `entryPath` with `launch`);
  `Equal<PluginProtocolSessionSpec["table"], BoundHostApiDispatchTable>` together with
  `{} extends Pick<PluginProtocolSessionSpec, "table"> ? false : true` (required);
  `Equal<Parameters<PluginChildTransport["request"]>[0], PluginInstanceMethod>`. The
  second round placed a "no `connect`" assertion in `out-of-process-plugin.test.ts`,
  which `tsconfig.json:29` excludes from `typecheck`; that placement is withdrawn.
- `src/plugins/__tests__/validate-boundary.test.ts` (new): walks the import graph with
  the same resolver `scripts/check-import-cycles.mjs` uses (`package.json:65`) from
  `src/main.ts`, `src/boot/**` and `src/plugins/runtime/**` and asserts that no reached
  module is under `src/plugins/validate/`; that among production modules
  `plugin-protocol-session.ts` is imported by exactly `out-of-process-plugin.ts` and
  `validate/validation-session.ts`; and that the identifier `observeChild` occurs in no
  production module other than `out-of-process-plugin.ts`, so no runtime caller observes
  a child or ends its input.
- `knip.jsonc`: `scripts/lib/plugin-isolation-type-assertions.ts` joins `entry` (compiled
  by `typecheck`; nothing imports it). The new production modules have importers.

*Tests.*

- `src/plugins/isolation/__tests__/plugin-child-transport.test.ts` (new):
  `requestMcp("tools/call", …)` writes a frame whose `_meta` holds exactly the two keys,
  `"2026-07-28"` and `{}`, beside the invocation token decision 63 added (remove the
  producer → fails); `request("tools/call", …)`
  throws (drop the method check → fails); `requestMcp` with a caller `_meta` throws;
  `probe` refuses `ave/instance/construct` and `tools/list`, and
  `probe("ave/host/nope")` resolves with the child's `-32601`. **Natural exit versus
  termination**, over a paired link whose `terminate` is recorded: firing the link's
  `onGone` rejects a pending request with the exit reason, calls `childGone` once and
  records **zero** terminations, and a following `close` records zero as well (make
  `peerGone` call `close` → fails); a request whose deadline expires records exactly one
  termination (drop the deadline's `close` → fails); a fatal framing error from the
  stream records exactly one (same revert on `:137`). **Faults**: firing `onFault` on a
  live link before any close rejects the pending request and records exactly one
  `terminate` (route the fault to `peerGone` → zero, fails); firing it after `onGone`
  records none. **A refused signal does not recurse**, over a scripted link that models
  production's sequence with fake timers: its `terminate` fires `onFault` synchronously
  from inside the call (as a refused `kill()` does) and arms one escalation timer, whose
  SIGKILL step fires `onFault` synchronously again. A fault before any close, then the
  grace period elapsed, then twice the grace period more: `terminate` is called exactly
  once with a maximum call depth of 1, exactly one escalation timer is ever armed, the
  SIGKILL step runs once, both refusals are in `terminationFaults`, the pending request
  is rejected, `exited` is unsettled, and nothing else is called (set `terminating`
  after `link.terminate` instead of before, or let a fault during the sequence call
  `terminate` → depth > 1 or a second timer, fails). The same with the sequence started
  by `teardown` instead of a fault: the same counts.
- `src/plugins/isolation/__tests__/plugin-protocol-session.test.ts` (new), over a paired
  link whose `terminate` is recorded: `runStopHook()` sends `ave/instance/stop` and no
  terminate follows (make it call `transport.close` → fails); **the natural-exit path**:
  `closeInput()` ends the child's input, the child end then closes and the link reports
  it gone, `exited` settles, `onClosed` has run once, the host watchers are gone, and
  the recorded terminate count is **zero** — and it stays zero after a following
  `teardown()` (route the session's exit release through `teardown`, or restore `onGone
  → close` in the transport → fails); **the forced path**, a separate case: `teardown()`
  on a live child terminates exactly once, calls `onClosed` once and is idempotent; **a
  failed signal delivery on a live child** — the link fires `onFault` while its child
  end stays open — leaves `exited` unsettled, records exactly one terminate, and only
  when the child end then closes does `exited` settle with the exit reason and
  `onClosed` run once (forward the fault to `onGone` → `exited` settles early, fails);
  **cancellation mid-construct** — a child end that reads construct and never replies,
  and a signal aborted 50 ms after the call — the opener rejects with the abort reason
  within 1 s, one terminate, `onClosed` once, no host watcher left; the child end then
  writes the construct reply, and nothing follows (no instance, no unhandled rejection,
  no second `onClosed`) (drop the signal listener → the opener waits for construct's own
  deadline, fails); an already-aborted signal rejects with no frame written;
  `instance.stop()` is one stop frame then exactly one terminate (the production
  behaviour of `:1496-1524`, unchanged); construct's `hostProtocol.capabilities` equals
  `hostProtocolCapabilities(spec.table)`, and a `spawnWorker` request whose
  `allowWritePaths` lie outside the table's envelope is refused (bind a wider envelope
  inside the session instead of using `spec.table` → fails).
- `src/plugins/validate/__tests__/validation-session.test.ts` (new): a manifest with a
  `userChosenDirectory` grant, validated with `AVE_HOME` pointing at a temporary
  directory whose `settings.json` approves that directory, gets the base envelope — the
  approval is not read and a worker request into it is refused (make
  `validationConfinement` pass `sandbox` → fails); an undeclared protocol is refused with
  no frame written.
- The golden, schema-parity, child-process-config and confined-child suites pass with
  the migrated consumers; the transcripts differ from `c73f59580` only by the `_meta` of
  the MCP request frames (drop the producer → every transcript fails). Delete one copied
  `entry.mjs` → that plugin's golden fails. `validate-boundary.test.ts`: add an import of
  `validation-session.ts` to `runtime/index.ts` → fails; add a third production importer
  of the session module → fails; pass `observeChild` from `runtime/index.ts` → fails. The
  type assertions: restore `connect` → `bun run typecheck` fails.

*Gates.* `bun run typecheck`; `bun run test:vitest -- run src/plugins/isolation
src/plugins/validate src/plugins/__tests__/validate-boundary.test.ts`; `bun run
check:import-cycles`; `check:knip:engine`; `bun run build`; naming gate (the moved file
and identifiers are its target); CI rollup, and the macOS confinement job (the real
spawn path changed shape and the confined cases now go through `observeChild`).

*Lock suites.* All six **unchanged**: an internal extraction, a moved test host and a
test-only spec member add no channel, export, bridge method, setting or package script.

##### P2. The validate CLI

*Files.*

- `src/plugins/validate/validate-plugin.ts` (new): `validatePluginDirectory(dir, options)`
  returning a report of `{ check, ok, path?, message }` rows. Checks, in order:
  1. **Manifest**: Ajv against the host-owned `schemas/plugin-manifest.schema.json`
     (the import at `manifest-validation.ts:16`) and the hardening pass
     (`parsePluginJson` and its callers in `manifest-validation.ts`), which after P3
     accepts either entry kind and applies the process rules (paths, reserved environment
     names, the `0.13.0` floor); `requires.hostProtocol` must be in the CLI build's served
     set (`isServedHostProtocolVersion`, `host-api-wire.ts:62`); `requires.minAppVersion`
     must be ≥ `HOST_PROTOCOL_FIRST_APP_VERSION[hostProtocol]`, a new constant beside
     `HOST_PROTOCOL_VERSIONS_SERVED` (`{ "2": "0.12.0" }`) that a test holds equal to the
     lowest `appVersion` recorded for that protocol in `mirror.json` (decision 29); a
     failure prints the JSON-pointer path (`#/extensions/ai.agent-connector.ave/requires/hostProtocol`).
  2. **Protocol**: `runProtocolChecks(launch, manifest, options)` spawns a
     `ValidationLaunch = { command, args, env }` with a plain `child_process.spawn` the
     CLI owns, wraps its pipes in the CLI's `ChildLink` (`exit` and a pid-less `error` →
     `onGone`, any other `error` → `onFault`, S1; its recording and its termination
     sequence below), and attaches it to `openValidationSession` with
     `createValidationHost` (S1). The launch is built per entry kind: `process.execPath
     [...childExecArgs] <sibling>/ave-plugin-child-main.js <entry>` for an `entry`
     plugin (P2); for a `process` plugin, the command, args and environment from P3's
     `resolveProcessLaunch` (`process-entry.ts`: the resolved command and args under
     policy `"process"`, the declared `env` pairs, then `PLUGIN_ROOT` and `PLUGIN_DATA`
     = a temporary directory). P2 merges after P3 (the one merge order), so it ships
     both arms and no commit on `main` has a CLI that accepts a `process` manifest
     without a launch for it. The CLI never calls `createOutOfProcessPluginFactory`,
     never confines (decision 30) and needs no sandbox: it proves protocol conformance
     without the app; confinement is proven by the host's own suite (§10.1 item 3). Its
     authority is the validation host's base envelope (`validationConfinement`, S1); a
     manifest's `sandbox` grants are not applied and are reported `not exercised` in a
     `sandbox.grants` row. For a `process` plugin the report also carries
     `process.confinement` (the entry ran unconfined; the app runs it only under a
     process-confining sandbox) and `process.provenance` (the sha256 pin is checked at
     install, and a source directory has none), both `not exercised` and never passed,
     and a `manifest.process` row for what `resolveProcessLaunch` refuses against the
     files (a missing `${PLUGIN_ROOT}/` path, a non-file command, a symlink escape),
     beside `manifest.entry` for an `entry` plugin. Construct's `entryPath` is derived
     from the factory's `launch` union as the factory derives it (the resolved command for
     a `process` launch, decision 33); `ValidationSessionInput.entryPath` stays as S1
     froze it. Every step goes through the S1 session:
     `openValidationSession` performs `ave/instance/construct` first
     (`out-of-process-plugin.ts:1436-1446`) → `instance.start()` →
     `instance.onPublished()` → `channel.requestMcp("server/discover")` →
     `channel.requestMcp("tools/list")` → `tools/call` through `instance.handlers` (the
     production path, which uses `requestMcp`) → `channel.probe(<unknown ave/host/*
     method>)` → `channel.runStopHook()` → `channel.closeInput()` → `channel.exited`
     raced against the deadline → `teardown`; **no MCP request precedes construct**, for
     either entry kind, because the host never sends one (§10.2 amended). **Every
     awaited step is bounded, and `runProtocolChecks` owns every bound** (host re-review
     #26). The CLI bypasses the runtime's timeout owners — `runStartWithTimeout` for
     `start` (`src/plugins/runtime/index.ts:1242-1256`) and the executor ceiling for a
     tool (`src/tools/executor-ceiling.ts:56-76`), which is why the proxy's own
     `tools/call`, `start` and `onPublished` requests carry no transport deadline
     (`out-of-process-plugin.ts:1472-1480`, `:1527-1535`;
     `plugin-child-transport.ts:159-165`; no timer without one,
     `child-stream-multiplex.ts:287-290`) — so it applies the same `TOOL_TIMEOUT_POLICY`
     values itself, one helper in `validate-plugin.ts` racing each operation against its
     bound: construct `pluginFactoryMs` → row `protocol.construct` — the runtime's owner
     of that wait is `runPluginFactoryWithTimeout` (`runtime/index.ts:1215-1227`, 10 s),
     applied at every activation (`:4007`, `:4912`, `:5528`, `:6282`) with the child's
     import inside it (`:5151-5154`), so a plugin that constructs in 15 s fails here as
     it would fail in the app (host re-review #30). The session's own construct
     deadline, `pluginImportMs + pluginFactoryMs` (20 s,
     `out-of-process-plugin.ts:1444`, `tool-timeout-policy.ts:131-132`), is unchanged
     and is **not** a validation bound: it is the transport's cleanup deadline that ends
     a child nobody is waiting for any more. `start` the manifest's `startupTimeoutMs`
     clamped to `pluginStartupMaxMs`, else `pluginStartupDefaultMs` — the runtime's rule
     → `lifecycle.start`; `onPublished` the same value as **validator-only policy** →
     `lifecycle.on-published`: the runtime awaits `onPublished` with no bound
     (`runtime/index.ts:3437`), so this is no parity claim, only a refusal to let one
     hook hang the validator and CI; `server/discover`, `tools/list` and the
     unknown-method probe `mcpRequestDefaultMs` → `discover.capabilities`, `tools.list`,
     `protocol.unknown-method`; each `tools/call` `globalCeilingMs`, the ceiling plugin
     tools inherit → `tools.call:<name>`; the stop hook `pluginStartupDefaultMs`
     (production's bound, `:1496-1507`) → `lifecycle.stop`; `closeInput` → `exited` 5 s
     → `protocol.stdin-close`. `--fast` caps every bound above at 1 s. Cancellation is
     one `AbortController` per run, created before the session and passed to
     `openValidationSession` as `signal` (S1), so it exists while construct is still
     pending (host re-review #29). On expiry the helper records that row as failed with
     `timed out after <n> ms` and aborts the controller with `validation deadline:
     <row>`; the session turns the abort into `teardown` — the destructive path, so the
     child is terminated and every pending call rejects — before construct completes as
     after it. Each later row is reported `not exercised: <row> timed out`, and the exit
     code is 1. No awaited operation in the CLI is unbounded, and the abort is its only
     cancellation. **Cleanup is unconditional and owned by the CLI** (cross-language
     re-review round 6, finding 1): `runProtocolChecks` spawns the child and hands it to
     `runProtocolChecksOnChild(child, manifest, options)`, whose `finally` runs on every
     path — including an opener that rejects (a refused protocol before any frame, a
     construct timeout or abort, a spawn failure), where no session exists. It acts
     through what the CLI holds before any session does: the run's `AbortController`
     (aborted, so a live session tears down) and **the CLI's link**, which records from
     spawn onward, independent of the session, the observed exit (`exitObserved`), every
     `onFault` reason (`terminationFaults`) and each signal it sent (`signalsSent`). Its
     `terminate` is `terminateChildProcess(child, VALIDATION_KILL_GRACE_MS)` with
     `VALIDATION_KILL_GRACE_MS = 3_000`, production's grace
     (`out-of-process-plugin.ts:970`; the helper's 2 s default,
     `terminate-child-process.ts:14`, is not used), and it starts its sequence at most
     once, so the transport's `close` and the finalizer cannot start two. The finalizer
     calls `link.terminate("validation finished")` unless the exit was already observed
     (a no-op when a sequence has started), then waits for `exitObserved` for
     `VALIDATION_TEARDOWN_WAIT_MS = 5_000` — the 3 s grace plus 2 s for the SIGKILL and
     its `exit` event — and reports **`protocol.teardown`**: passed on an observed exit,
     else failed `child did not exit after termination` with `terminationFaults` and
     `signalsSent`. That row is **always reported**, exempt from the `not exercised`
     rule, and **not capped by `--fast`**, because a 1 s wait would end before the
     escalation it reports on (finding 2). The S1 session exposes no diagnostic accessor
     for this; `terminationFaults` on the transport stays internal (logged), and the CLI
     reads its own link. Asserted: every stdout line is a JSON object terminated by
     `0x0A` and nothing else is written to stdout, checked on the **raw bytes** the CLI
     tees beside the decoder (fact 11), so a bare `ready` line or a `Content-Length:`
     header fails `protocol.stdout-discipline` even though `StdioFrameDecoder` would
     have dropped it (the decoder is not changed; production stays tolerant, decision
     40); every MCP request frame the CLI sent carries the two required `_meta` keys
     (the transport's producer, S1; checked on the recorded host-side frames, so a
     regression in the producer fails `protocol.request-meta` rather than passing
     silently against a tolerant runtime); `server/discover` lists `2026-07-28` in
     `supportedVersions` and advertises `capabilities.tools` when the manifest declares
     tools (`discover.capabilities`); `tools/list` returns exactly the manifest's tools
     (`tools.list`); construct's `pluginProtocol.requires` ⊆ the capabilities the
     validation host advertised (`construct.requires`); the unknown-method probe is
     answered `-32601` (`protocol.unknown-method`); after the stop hook the CLI **closes
     stdin and nothing else** — `runStopHook` neither closes the transport nor
     terminates, fact 14 — and the process must exit within 5 s (1 s under `--fast`); on
     timeout the row `protocol.stdin-close` fails, and only after the failure is
     recorded does `teardown` terminate the child (after an observed exit `teardown`
     only releases the host side, since terminating an exited child is a no-op,
     `src/tools/terminate-child-process.ts:12-34`, which the CLI's own link uses too).
     `tools/call` is issued with `{}` for every declared tool whose `inputSchema` has no
     `required` properties, and with the arguments from `--tool-args <file.json>` for
     the others; a tool with no arguments available is reported `not exercised`, not
     failed (decision 31). On `win32` the protocol step for a `process` plugin is
     reported `not exercised: process entries do not run on win32` (§2.2) and the
     manifest and source checks still run.
  3. **Source drift**: the checks the meeting script does today, ported from
     `validate-hostapi.mjs:10-17` and `ui-bridge-usage.mjs` (official repository) into
     `src/plugins/validate/source-drift.ts`: `emitEvent`/`onEvent` literals in
     `src/**/*.ts` and `dist/**/*.js` against `emittedEvents`/`eventSubscriptions`
     (`schemas/plugin-manifest.schema.json:417`, `:359`), `bridge.callTool` targets
     against tools with `app` visibility, `bridge.onEvent` against bridged events. The
     three `permissions` checks (`validate-hostapi.mjs:7-9`) are **not** ported: the host
     enforces no `permissions` entry (fact 6), so a check on it would be a claim about
     nothing.
  4. Exit `0` when every row is `ok` or `not exercised`, else `1`; rows to stdout as JSON
     lines, a summary to stderr.
- `src/plugins/validate/cli.ts` (new): argv → `validatePluginDirectory` → exit code. This
  is the entry the official repository bundles as `tools/vendor/ave-plugin-validate.js`
  (the `build` entry shape of `tools/vendor/sources.json`, fact 6), beside a second
  bundle, `tools/vendor/ave-plugin-child-main.js` from
  `src/plugins/isolation/plugin-child-main.ts` (the esbuild entry at
  `scripts/build-main-esbuild.mjs:47`), which the CLI locates relative to its own
  `import.meta.url` and which `--child-entry <path>` overrides. `--child-exec-arg <arg>`
  (repeatable) is prepended to the child's `process.execPath` invocation; a spawned child
  inherits none of the parent's Node flags, so source mode must say so.
- `package.json`: `plugin:validate` = `node --import tsx --import
  ./scripts/lib/stub-app-logger-hook.mjs src/plugins/validate/cli.ts --child-entry
  src/plugins/isolation/plugin-child-main.ts --child-exec-arg=--import
  --child-exec-arg=tsx --child-exec-arg=--import
  --child-exec-arg=./scripts/lib/stub-app-logger-hook.mjs` (`tsx` is the loader
  `check:i18n-catalog` uses, `:59`), so the app repository can validate the five
  fixtures and any local plugin **without a build**: the child source imports `.js`
  specifiers backed by `.ts` files (`plugin-child-main.ts:31`), which plain `node`
  cannot resolve.
- `scripts/lib/stub-app-logger-hook.mjs` (new) — **source mode silences the host logger
  exactly as the bundle recipe does** (host re-review #27, cross-language re-review
  round 3, finding 3). Loaded by `--import` before the entry, it registers a resolve hook
  that, after the next resolver (tsx) has resolved a specifier, replaces the module at `<checkout>/src/lib/logger.ts` with the same silent
  `createLogger` the recipe substitutes (`bundle-app-marketplace.mjs:16-29` at
  `e53fb40a8`). Replacing the module is required, not a choice among equals: the app
  logger decides its destination when first imported (`logger.ts:70-99`), and its
  default pretty stream and its test-mode path (`createLogger` → `console.log` whenever
  `VITEST` or `NODE_ENV=test` is set, `:223-259`) both reach stdout, so neither a
  `LOG_LEVEL` value nor rebinding `process.stdout.write` covers every case. A graph that
  imports any other export of `logger.js` then fails to link in source mode exactly as it
  fails to build in bundle mode. The CLI writes its report through `process.stdout` and
  its summary to stderr; nothing else can reach stdout in either mode. The hook is passed
  to the source-mode child too, so the child's host modules are silenced as in the
  child-main bundle and cannot touch the protocol stream. The hook registers the same
  kind of hook tsx does: `module.registerHooks` (in-thread) on Node 24.11.1+, 25.1+ and
  26+, tsx 4.22's own gate, else `module.register`; with Node 26 deprecating
  `module.register` (DEP0205) and tsx registering in-thread, a loader-thread hook beside
  it was reproduced to leave a `.ts` entry silently unrun. `knip.jsonc` gains the hook as
  an entry (loaded by `--import`, nothing imports it).
- `knip.jsonc:36-51`: `src/plugins/validate/cli.ts` joins the entry list with the reason
  the checker's line would have (bundled from a foreign repository, nothing imports it).
- `docs/guides/plugin-development.md` ("Testing Checklist", `:168`): the CLI replaces the
  "validate `plugin.json` with manifest tests" line (`:172`).

The bundle reaches `electron` transitively (`host-api-dispatcher.ts` →
`permissions/effect-enforcement.ts` → `approval-gate.ts` → `main/notification-service.ts`),
exactly as the vendored checker already does (`repository-check.ts` →
`marketplace/content/kinds.ts` → `main/skill-store.ts` → `lib/logger.ts` →
`main/exec-mode.ts` → `approval-gate.ts`), and runs under bare Node for the same reason
the checker does: the `electron` module resolves to its path string and nothing in the
validate path calls into it. That is a fact about today's graph, not a promise, so the
bundle test below executes the built file in a plain `node`. **Logger behaviour in the
bundles is intended to be silent**: both vendored bundles are built with the post-wave
recipe, which replaces `src/lib/logger.js` with a no-op logger (fact 17). For the CLI
this is required, not tolerated — the app logger writes to stdout outside a headless run
(`logger.ts:70-99`), and stdout is the CLI's JSON-lines report; the CLI's own output is
the report on stdout and the summary on stderr, never the host logger. For the
child-main bundle it drops only host-module diagnostics; the plugin's own `context.log`
still crosses as `notifications/ave/log`, and the production child (built by esbuild,
`scripts/build-main-esbuild.mjs:47`) keeps the real logger. **Source mode uses the same
substitution**, not a variant: `npm run plugin:validate` loads
`scripts/lib/stub-app-logger-hook.mjs` in the CLI and in its child (above), so all three
ways of running the validator — source, CLI bundle, child-main bundle — run without the
app logger, and one test per mode parses every stdout line as a report row.

*Tests.*

- `src/plugins/validate/__tests__/validate-plugin.test.ts` (new), each row against a
  fixture: the five self-contained plugin fixtures under `fixtures/host-protocol/2/plugins/*`
  (S1) pass every check (break the manifest of one); `hostProtocol: "1"` fails with the
  pointer path (remove the served-set check); `minAppVersion: "0.11.0"` with
  `hostProtocol: "2"` fails (remove the first-version rule); `pluginProtocol.requires`
  naming a method the validation host lacks fails `construct.requires` (remove the subset
  check); an `emitEvent("x")` with no `emittedEvents` entry fails `events.emit-undeclared`
  (remove the scan); a `tools/list` before construct is **not** sent (a recording link
  asserts the first frame is construct; revert: reorder).
- **Dedicated raw child-process fixtures** under
  `src/plugins/validate/__tests__/fixtures/raw/`, each a plain `.mjs` script that speaks
  just enough protocol on its own stdin/stdout to reach its case (an `entry` fixture run
  by the reference runtime cannot produce these behaviours, fact 12), handed to
  `runProtocolChecks` **directly** as a `ValidationLaunch` of `process.execPath
  <script>` with a minimal manifest — below the manifest step, so the cases need neither
  P3 nor a `process` manifest and run on every platform: `ignores-stdin-close` keeps a
  timer alive and ignores `end` → `protocol.stdin-close` fails under `--fast` and the
  harness asserts the failure was recorded **before** the kill (remove the timer, or
  make the CLI terminate instead of closing stdin); `bare-stdout-line` prints `ready\n`
  before its first frame → `protocol.stdout-discipline` fails while the same bytes fed
  through `StdioFrameDecoder` still yield every frame (remove the raw check);
  `content-length-header` frames one reply with a `Content-Length:` header → fails the
  same row (same revert); **`withholds-start-reply`** answers construct and then never
  answers `ave/instance/start` → under `--fast`, `lifecycle.start` fails `timed out
  after 1000 ms` within 5 s of the run, the recording link sees exactly one terminate,
  every later row except `protocol.teardown` is `not exercised`, `protocol.teardown`
  passes and the exit code is 1 (remove the bound → the case hangs until the test's own
  timeout and fails); **`withholds-tool-reply`** answers through `tools/list` and never
  answers `tools/call` → `tools.call:echo` fails the same way (same revert);
  **`withholds-construct`** reads construct and never answers → under `--fast`,
  `protocol.construct` fails `timed out after 1000 ms` and the CLI exits 1 within 3 s —
  long before the 20 s cleanup deadline — with exactly one terminate, no live child or
  open handle left, and a reply the fixture writes 2 s later ignored, and the run's
  `signal` is the one `openValidationSession` received (remove the finalizer → no
  `protocol.teardown` row is reported, fails; the signal-specific
  proof is S1's mid-construct cancellation test, because the finalizer alone would also
  end this run); **`slow-construct`** answers construct after 10.5 s, run **without**
  `--fast` → `protocol.construct` fails at 10 s with every later row but
  `protocol.teardown` `not exercised` (bound construct at `pluginImportMs +
  pluginFactoryMs` again → construct passes at 10.5 s, fails). It is the suite's one
  slow case, with a 20 s test timeout. **`ignores-sigterm`** answers construct, installs
  a no-op `SIGTERM` handler and never answers start → under `--fast`, `lifecycle.start`
  fails at 1 s; **on macOS and Linux** the link's `signalsSent` is exactly one `SIGTERM`
  and, 3 s later, one `SIGKILL`, the child's exit is observed and **`protocol.teardown`
  passes**; exit code 1 (let `--fast` cap the teardown wait → the row fails before the
  SIGKILL, fails; use the helper's 2 s default → the SIGKILL timing assertion fails).
  **On Windows** Node's `kill("SIGTERM")` ends the process forcefully — "the process
  will always be killed forcefully and abruptly"
  (<https://nodejs.org/api/child_process.html#subprocesskillsignal>, checked 2026-10-01)
  — so a handler cannot ignore it: the same case asserts exactly one `SIGTERM`, no
  `SIGKILL`, the exit observed before the grace period ends and `protocol.teardown`
  passed. The escalation is proven there by the scripted-link and injected-refusal
  cases, which are cross-platform. **Refused signals**, the case this row exists for,
  distinct from the one above: `withholds-construct` and `withholds-start-reply`, each
  spawned by the test and passed to `runProtocolChecksOnChild` with that one child
  instance's `kill` replaced by Node's refusal path (emit `error` with `code: "EPERM"`
  synchronously, return `false`), under `--fast` → the timeout row fails
  (`protocol.construct`, resp. `lifecycle.start`), every later row but
  `protocol.teardown` is `not exercised`, and `protocol.teardown` fails `child did not
  exit after termination` after 5 s with `signalsSent` `SIGTERM` then `SIGKILL` and two
  `terminationFaults`, one per refusal; and the CLI **returns**, exit code 1, within 1 s
  after that 5 s wait ends — 7 s from the run's start for the construct case — although
  the child is still alive (host re-review #32: an unexited child bounds the run, never
  holds it); the test's `afterEach` kills the child by pid (skip the finalizer when the
  opener rejects → the construct case has no `protocol.teardown` row, fails; report
  `protocol.teardown` as `not exercised` after a timeout → both fail).
  `knip.jsonc:47-50` gains the `fixtures/raw/*.mjs` glob beside the host-protocol one.
- The session-level rows: a recording link shows every `server/discover`, `tools/list`
  and `tools/call` frame carrying both `_meta` keys (replace the transport's producer
  with a pass-through → `protocol.request-meta` fails); a fixture whose manifest declares
  a `sandbox` grant is reported `sandbox.grants: not exercised` and the protocol rows
  still pass (report the grant as `ok` → fails); after `runStopHook` the recording link
  sees no terminate before the child's exit (make the CLI call `teardown` first →
  fails).
- The `process` arm (P2 merges after P3): a minimal `process` fixture
  whose `bin/plugin` is a `#!/bin/sh` script that `exec`s `node` on a protocol script
  passes the manifest and protocol steps on macOS and Linux, receives the declared `env`
  pair and `PLUGIN_ROOT`/`PLUGIN_DATA`, and on `win32` is reported protocol `not
  exercised` with the manifest step still run (remove the arm → the protocol row fails);
  its `process.confinement` and `process.provenance` rows are `not exercised` (report
  either as passed, or drop it → fails), and a missing `${PLUGIN_ROOT}/` path, a
  directory as the command, a reserved `env` name and a command outside the root each
  fail before any child is spawned.
- `src/plugins/isolation/__tests__/host-protocol-mirror-first-version.test.ts` (new, or a
  case in `host-protocol-schema-parity.test.ts`): `HOST_PROTOCOL_FIRST_APP_VERSION["2"]`
  equals the lowest `appVersion` for protocol `2` in `mirror.json` (edit the constant).
- `test/scripts/plugin-validate-source-mode.test.ts` (new): `bun run plugin:validate
  <fixture>` on the `local-indexer` fixture in a checkout with **no `dist/`**, exit 0
  (drop the `--child-exec-arg` pair → `ERR_MODULE_NOT_FOUND` for
  `src/plugins/runtime/plugin-loader.js`); and **stdout carries only the report**: the
  same command on a fixture whose plugin logs through `context.log` at construct, start
  and in its tool — so the host side logs each `notifications/ave/log` it receives
  (`out-of-process-plugin.ts:1218-1223`) — run once with the test runner's environment
  (`VITEST` set, the logger's test-mode path) and once with `VITEST` and `NODE_ENV`
  removed (its pretty-stream path), parses **every** stdout line as JSON with exactly
  the report-row keys `{ check, ok, message }` plus an optional `path`, and finds the
  plugin's log text nowhere on stdout (drop the `--import` of the logger hook from
  `plugin:validate` → a host log line reaches stdout and the parse fails).
- `test/scripts/validate-plugin-bundle.test.ts` (new): builds both bundles with **the
  recipe the plugin repositories will use** — the official repository's
  `tools/bundle-app-marketplace.mjs` at the candidate wave (`e53fb40a8`, fact 17), whose
  bytes the test carries as a fixture file with that commit and its sha256 in a header,
  run as `bun -e <recipe> <app checkout> <entry>` from the checkout, exactly as
  `vendor.mjs:103-105` runs it — for `src/plugins/validate/cli.ts` and
  `src/plugins/isolation/plugin-child-main.ts`, into a temporary directory; asserts that
  neither output contains `pino` and that both pass the embedded-absolute-path rule of
  `vendor.mjs:37-43` (ported as a helper beside the fixture); then runs the CLI bundle
  with plain `node` on the `hello-world`-shaped fixture and on a broken one, asserting
  exit codes, that the report names the failing check, and that **stdout holds only the
  report's JSON lines** (build without the logger stub → the host logger's lines reach
  stdout and the case fails; make the entry import something that calls `electron` at
  load → fails). The recipe fixture is refreshed only when the official repository
  changes its recipe, and the test names the commit it came from.

*Gates.* `bun run typecheck`; `bun run test:vitest -- run src/plugins/validate
src/plugins/isolation test/scripts/validate-plugin-bundle.test.ts
test/scripts/plugin-validate-source-mode.test.ts`; `bun run build`; `check:knip:engine`;
naming gate; CI rollup.

*Lock suites.* `packaging-discipline-source` runs because `package.json` scripts change
(a non-`build` script; its `build`-chain assertions are unchanged). `channel-inventory`,
`host-renderer-only-channels`, `domain-exports`, `preload-shape`, `settings-store`
**unchanged**.

##### P3. The `process` entry: runtime

P3 is complete on its own: after it merges, a `process` manifest can reach the runtime
only with pinned provenance on **every** activation path, only under a live confinement
that includes processes, with no manifest byte in the wrapper's environment, and the
marketplace still refuses to install one until P4.

*Files.*

- `schemas/plugin-manifest.schema.json:1121-1160`, `:1194-1222` — **tightened, not
  added** (fact 4). Changed: `command`'s pattern becomes
  `^(?:\./|\$\{PLUGIN_ROOT\}/)(?:[^/\\=]+/)*[^/\\=]+$` — inside the plugin root only, the
  bare-name alternative withdrawn (decision 32; §7.3 "no `PATH` search for a marketplace
  plugin" wins over §2.1's former "bare executable name", and §2.1 is amended), and no
  `=` in any segment, because the launch below hands the command to `/usr/bin/env`, which
  reads an operand containing `=` as an assignment (decision 36). Kept as
  they are: `command` 1-200 chars and no CR/LF, `args` ≤ 64 × ≤ 1000 chars, `env` ≤ 64
  keys named `^[A-Za-z_][A-Za-z0-9_]{0,63}$` with values ≤ 4096 chars, the three-way
  `oneOf` with `mcpAuth: false` in both executable branches. Not expressed in the schema,
  enforced in hardening (one source, fact 9): the reserved environment names, the path
  rules for `args`/`env` values, and the version floor.
- `src/plugins/public-contract.ts`: the interface `PluginManifest` (`:441`, `entry:
  string` at `:452`) becomes an **exclusive union** — its members minus `entry` move to
  `interface PluginManifestFields`, and `export interface EntryPluginManifest extends
  PluginManifestFields { entry: string; process?: never }`, `export interface
  ProcessPluginManifest extends PluginManifestFields { process: PluginProcessEntry;
  entry?: never }`, `export type PluginManifest = EntryPluginManifest |
  ProcessPluginManifest`. Two optional properties would have let the type — and the
  schema projected from it — accept both and neither (host re-review #20). The Agent
  Plugins projection (`:55-63`) gains `process?`; a total `pluginEntryKind(manifest):
  "entry" | "process"` (a narrowing on `manifest.process !== undefined`) replaces every
  `manifest.entry` read that assumed a string (the compiler finds them:
  `resolveRealEntryPath` at `runtime/index.ts:3960`, `resolveEntryPathForPlugin` at
  `:3943`, `:4856`, `:5482`, `:6230` and `:7483`, the routing at `:5143-5167`,
  `direct-package.ts:122`, the official checker). This is the `PluginManifest` **wire**
  change (fact 12; decision 33): the generated `$defs.types.PluginManifest` becomes
  `anyOf` of `$ref`s to `EntryPluginManifest` and `ProcessPluginManifest`, with `entry`
  required in the first and `process` in the second (today one object with `entry` in
  `required`, `protocol.schema.json:7503-7508`).
- `scripts/lib/plugin-host-protocol-schema.ts` — **the generator rule that makes the
  union exclusive on the wire**. `ts-json-schema-generator` 2.9.0 drops a property whose
  type is `never` (`node_modules/ts-json-schema-generator/dist/src/NodeParser/TypeLiteralNodeParser.js:45`,
  `dist/src/TypeFormatter/ObjectTypeFormatter.js:52`), so on its own it would emit both
  branches without the excluded key and, with `additionalProperties: true` (`:344`),
  accept a manifest with both. Reproduced 2026-10-01 in a scratch directory with the
  repository's generator and the configuration of `:336-346`: an exported union of the two
  interfaces projects to `anyOf: [{ $ref: EntryPluginManifest }, { $ref:
  ProcessPluginManifest }]` whose definitions omit `process` and `entry` respectively.
  The rule, general and source-derived rather than a `PluginManifest` special case: after
  projection, for every exported interface in the three source files (the `named` map,
  `:371-375`) and every property signature it declares whose type node is `never`, the
  emitted `$defs.types.<Interface>.properties.<name>` is set to `false` — the same
  `false` subschema the manifest schema already uses for the same exclusion
  (`schemas/plugin-manifest.schema.json:1200-1203`, `:1210-1213`). A property declared
  `never` whose interface is not emitted is a generator error, not a silent skip. The one
  exemption is the generator's `TABLE_DECLARATIONS` list (`HostApiEventPayloads`), the
  declarations it reads as data tables — where `never` means "pushes nothing" and nothing
  is emitted — and each table's reader takes its name from that same list. Checked
  the same day: Ajv 2020 (the repository's `node_modules/ajv/dist/2020.js`) accepts an
  entry-only and a process-only object and rejects both-present and neither against that
  shape, and `json-schema-to-typescript` 15.0.4 compiles a `false` property back to
  `process?: never`, so P1's client keeps the exclusion.
- `src/plugins/process-entry-support.ts` becomes `src/plugins/process-entry.ts`:
  `hasProcessEntry` stays; `ProcessEntryUnsupportedError` and its code are deleted;
  `ProcessEntryUnconfinedError` (`process-entry-unconfined`) and
  `ProcessEntryRequiresPinnedArtifactError` (`process-entry-requires-pinned-artifact`)
  are added; `PROCESS_ENTRY_FIRST_APP_VERSION = "0.13.0"` (decision 38);
  `resolveProcessLaunch(manifest, generationRoot, pluginDataDir)` — the one builder of
  `{ command, args, env }` (the resolver below, the declared pairs, then the host-owned
  pair) that the factory and the validate CLI share; and
  `assertProcessEntryAdmitted(manifest, verified)` — for a `process` manifest, `verified`
  must be present with `installSource === "git"`, `rung` `release` or `archive` and a
  non-null `artifactSha256`, else the pinned-artifact error; for an `entry` manifest it
  is a no-op. `manifest-validation.ts:916` drops `assertProcessEntrySupported`;
  `:917-923` becomes the exactly-one rule plus the `process` shape checks: **paths**
  (below), **environment names** through `isSafeMcpEnvironmentName` (`safe-names.ts:50-53`,
  refusing `RESERVED_ENV_NAMES` case-insensitively through `toUpperCase()`, the launcher
  family, and `PLUGIN_ROOT`/`PLUGIN_DATA`) with the pointer
  `#/extensions/ai.agent-connector.ave/process/env/<NAME>`. The helper compares the two host names
  **case-sensitively** today (`name !== "PLUGIN_ROOT" && name !== "PLUGIN_DATA"`,
  `:53`); P3 corrects it to compare `name.toUpperCase()`, like the reserved set, so
  `plugin_root` and `Plugin_Data` are refused for MCP servers and process entries alike,
  with a new `src/mcp/__tests__/safe-names.test.ts` (no suite tests the helper directly
  at `c73f59580`) holding each spelling (revert: restore the case-sensitive comparison).
  And
  **`requires.minAppVersion ≥ 0.13.0`** for a process manifest (protocol `2` began at
  0.12.0 but process execution begins at 0.13.0; a 0.12.x app that selected such a
  version would install what its runtime refuses, `catalog/aggregate.ts:85-89`). The
  hardening runs at install, at load and in the CLI, so no path admits a process manifest
  the runtime cannot honour. `requires.hostProtocol` stays mandatory for both kinds.
- `src/plugins/resolve-bundled-argv.ts:59-119`: policy `"process"` joins `"hook" | "mcp"`
  with **two contained-path rules** (decision 37): the executable (`command`) is anchored
  through `anchorBundledCommand` (`plugin-bundled-command.ts:45-58`) — realpath inside
  the retained generation, `O_NOFOLLOW`, **regular file**; every `args` element and every
  `env` value that begins with `${PLUGIN_ROOT}/` goes through a new `containedRootPath(rootReal,
  suffix, label)` with the shape of `containedDataPath` (`:42-51`): relative segments
  only, the path **must exist**, its realpath must lie inside the root, and it may be a
  **file or a directory** (a vendor tree is a directory; the artifact is immutable, so a
  missing path is a manifest error); `${PLUGIN_DATA}` and `${PLUGIN_DATA}/…` go through
  `containedDataPath` as today (the leaf may not exist yet). `args` literals keep the
  resolver's rule at `:97` (no `${`, no undeclared path-like token); `env` values that are
  not tokens are passed as opaque literals — they are data the confined process reads,
  not paths the host resolves — and may not contain `${`. The fingerprint the resolver
  returns is unused for a process entry: the artifact hash in the receipt already pins the
  bytes.
- `src/plugins/isolation/out-of-process-plugin.ts` (on S1's shape): `OutOfProcessPluginSpec`
  (`:992-1009` less `connect`) gains `launch: { kind: "entry"; entryPath } | { kind:
  "process"; command; args; env }` (the resolver's output), which **replaces** the
  top-level `entryPath`: construct's `entryPath` is derived from it (`entryPath` for an
  entry launch, the resolved `command` for a process launch), so one value has one
  source. The exact key set in `scripts/lib/plugin-isolation-type-assertions.ts` (S1)
  swaps `entryPath` for `launch` in the same PR;
  `ConfinedPluginChildSpec`
  (`:705-739`) carries it; `spawnConfinedPluginChild` (`:817`, the one call at `:914-947`)
  keeps `process.execPath` + `ELECTRON_RUN_AS_NODE=1` for an entry launch and, for a
  process launch, spawns **`/usr/bin/env`** with `args: [...manifestPairs,
  "PLUGIN_ROOT=<root>", "PLUGIN_DATA=<data>", <resolved command>, ...resolvedArgs]` (the
  one order used everywhere in this plan: manifest pairs, host-owned pairs, command,
  arguments), so every
  variable — host-owned and declared — is set by a process that already runs inside the
  wrap, and the outer `bash -c` (fact 9) sees `baseEnv: buildSafeChildEnv()` with **no
  extras** and `extraEnv` of exactly the sandbox HOME (`:934`) — **no manifest byte
  reaches the wrapper's environment** (decision 36). The host-owned pair is placed
  **after** the manifest pairs in the `env` argv, so it is authoritative even if the name
  rule were bypassed; `/usr/bin/env` is required to be a regular file at spawn (both
  supported platforms ship it; a missing one is an environment error named as such), and
  a resolved absolute command path that contains `=` (possible only through a
  user-chosen home or data directory, since the schema refuses it in the manifest) is
  refused before the spawn with an error naming the path, never passed to `env`.
  Every token is quoted by `buildConfinedCommandLine` (`confined-child.ts:189-200`) as
  today. `allowRead`/`allowWrite` are the envelope (`:931-932`; the plugin root is already
  readable, `:670`). **Before** the spawn — beside `connectionHostProtocol` at `:1156` — a
  process launch requires `isAsrtSandboxActive()` (`permissions/asrt-sandbox.ts:477`) and
  `process.platform !== "win32"`, else `ProcessEntryUnconfinedError` (§2.2, §7.3; the
  deny floor and the wrap stay owned by `spawnConfinedChild`, `confined-child.ts:15-21`,
  `:109`); with the sandbox off there is therefore **no** unwrapped process launch, unlike
  the entry launch decision 3 describes. Construct's `entryPath` is the resolved absolute
  command path for a process launch (decision 33); its JSDoc at
  `plugin-instance-wire.ts:84-85` is amended. P3 regenerates the protocol schema (the
  `PluginManifest` type and the description), refreshes the `2/v0.13.0` candidate and the
  client, and adds a process-launch `construct` golden.
- `src/plugins/runtime/index.ts`:
  - `PluginIntegrityCheckResult.verified` (`:1445-1452`) gains `rung: ArtifactRung |
    null`, set from `receipt.git.rung` for a `git` receipt (`verifyPluginIntegrity`,
    `:1586-1590`) and `null` otherwise; `reportPluginIntegrity` (`:1620-1625`) audits it.
  - `importPluginFactoryForLifecycle` (`:5143-5148`) gains a required parameter
    `verified: PluginIntegrityCheckResult["verified"] | undefined` and calls
    `assertProcessEntryAdmitted(manifest, verified)` **first**, before the routing — so
    all four activation paths (fact 8) refuse a process manifest without pinned
    provenance before any factory exists (decision 35). Each caller passes its own
    evidence: boot from the preflight's integrity result (`:5189` → the plan; call at
    `:5498`), add from `:3839` (call at `:3964`), restart from `:6121-6123` (call at
    `:6240`), and prepared activation from **`verifyInstallReceiptRaw`**
    (`plugin-install-receipt.ts:315`) over `input.receiptRaw` against the materialised
    payload root (`:4846-4853`; call at `:4857`) — the staged receipt is verified the same
    way a cached one is, and a v3 receipt, a `local-dev` or `marketplace` receipt, or a
    tree rung fails the gate with `process-entry-requires-pinned-artifact`.
  - **Error precedence** (host re-review #22). A directory with **no receipt** never
    reaches the gate, on any path, and the plan no longer promises it the process code:
    (1) boot with a registry id verifies first and fails `install receipt missing or
    unreadable` (`plugin-install-receipt.ts:305-309`, preflight `:1499-1515`), marked by
    `markReceiptIntegrityFailed` **before the manifest is read** (`:5369-5379`, "the
    manifest was never read"); add with a registry id does the same (`:3838-3855`); restart
    with a receipt id returns `failed` (`:6121-6126`); (2) every non-prepared path without
    an id reads the receipt to materialise the generation (`:3089`, from
    `materializeImmutableRuntimeRoot` at `:3935`, `:5474` and `:6222`) and throws `ENOENT`
    before the import, and with no receipt cache root at all it throws "plugin generation
    lifecycle requires installReceiptCacheRoot" (`:3085-3087`); (3) prepared activation
    takes the staged receipt as its input, so it has no no-receipt state. All of these are
    fail-closed and name the receipt; producing the process-specific code there would mean
    reading and classifying a manifest whose bytes no receipt vouches for, on a failure
    path, to change only the message — rejected. The gate's own no-evidence case is the
    one that remains reachable: a **valid receipt that was never verified on this path**
    (boot or add without a registry id, `:1499`, `:3838`; restart without a receipt id,
    `:6121-6123`), where the generation materialises from the receipt but `verified` is
    `undefined` — refused `process-entry-requires-pinned-artifact`. So the order is: receipt
    integrity (existing refusals) → the provenance gate → routing → the sandbox check at
    spawn (`process-entry-unconfined`).
  - Then routing by manifest shape — a `process` manifest is out of process regardless of
    the census (`isOutOfProcessPlugin`, `:5150`), because it has no module the in-process
    arm could import; a contract property, not a routing exception, and the census stays
    frozen. `markIncompatibleHostProtocol`'s two call sites (`:3866`, `:5441`) gain
    siblings `markProcessEntryUnconfined` and `markProcessEntryUnpinned` so every load
    path refuses with a status the Doctor names ("runs only under an OS sandbox that
    confines processes"; "requires an install pinned by a release or archive artifact").
    The Doctor kind mapping at `:5392-5394` maps the two new errors.
- `.github/workflows/ci.yml`: a new job **`linux-confinement-tests`** ("Linux
  confinement path tests", `runs-on: ubuntu-24.04-arm`, the architecture of
  `build-and-test` so the native-module cache key and the ASRT `arm64` seccomp filter
  both apply, fact 7), shaped like the macOS job (`:327-375`): checkout and the docs-only
  classification step (`:335`), then — each step skipped only on a docs-only diff —
  `sudo apt-get update && sudo apt-get install -y bubblewrap socat ripgrep`;
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (fact 7; a runner
  setting, not a product change: the app never changes a user's sysctl, and on such a
  host the sandbox fails to initialise and a `process` entry is refused
  `process-entry-unconfined`); a **backend proof** step, `bwrap --version && socat -V |
  head -1 && rg --version | head -1 && bwrap --unshare-all --ro-bind / / --dev /dev
  --proc /proc /bin/true`, so a runner that cannot create the namespace fails there with
  its own message rather than inside a test; `setup-bun`, the `node_modules` cache and
  `bun install --frozen-lockfile` as at `:345-358`; then
  `AVE_REQUIRE_SANDBOX_CASES=1 bun run test -- src/plugins/isolation/__tests__/confined-plugin-child.test.ts`.
  With the flag set a case that cannot initialise the sandbox **fails** (`:188-216`), so
  a green job is a measurement, not an early return. It becomes a **required** status
  beside `build-and-test` and `naming-gate` when P3 merges (the branch-protection change
  is the owner's, recorded in the PR); a red run there is what "Linux confinement is
  exercised" means from P3 on. The macOS job (`:327`) is unchanged by P3. The job is
  created **in P3** because P3's own merge gate is the first that needs it; S1, which
  changes the shape of the real spawn path but no platform behaviour, is gated on the
  macOS job, and P5 extends the job P3 created.
- `src/shared/plugin-install-failure.ts:1-10`, `:52-58`: `process-entry-unsupported` is
  replaced by `process-entry-unconfined` and `process-entry-requires-pinned-artifact`,
  both not reinstall-fixable, with the comment block (`:29-31`) rewritten. `en.ts:75`,
  `ko.ts:70`, `format-ipc-error.ts:9`, `labels.ts:114`, `plugin-install-result.ts:56-60`,
  `ipc/domains/plugins.ts:486-488` and `src/ui/renderer/tabs/PluginConfigTab.tsx:519-520`,
  `:855`, `:874`, `:896-897` (the banner and the plugin card's failure text): the same
  rename, two keys each. The marketplace sites (`errors.ts:37`, `manifest-rules.ts:107`,
  `direct-package.ts:118-120`, `plugin-ladder.ts:156-158`, `marketplace.ts:833`,
  `:1029`) get a **mechanical** change in P3 only — the deleted constant and class are
  replaced by `PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE` and its error, and every one
  of them still refuses every process manifest unconditionally — so no commit between
  P3 and P4 installs a process entry anywhere, and the runtime gate above covers what is
  already on disk. The admission logic at those sites is P4's.
- Documentation carried: §2.1 (this amendment), `docs/guides/plugin-development.md`
  "Manifest Basics" (`:17`) gains the `process` form and its rules.

*Tests.*

- `src/plugins/__tests__/manifest-validation-hardening.test.ts` and
  `src/plugins/runtime/__tests__/manifest-validation-error-clarity.test.ts` (existing): a
  `process` manifest with `./bin/plugin`, `args: ["${PLUGIN_ROOT}/vendor", "--x=1"]` and
  `env: { SMOKE_VENDOR_DIR: "${PLUGIN_ROOT}/vendor" }`, `minAppVersion: "0.13.0"` passes;
  refused with the field path, each by removing its rule: a bare command, an absolute
  path, a `..` segment, a `${HOME}` token in `args`, an `args` literal that looks like a
  path, both `entry` and `process`, neither with `tools`, `minAppVersion: "0.12.0"`,
  and each of `BASH_ENV`, `LD_PRELOAD`, `NODE_OPTIONS`, `PYTHONPATH`, `PLUGIN_ROOT`,
  `PLUGIN_DATA` and `Path` as an `env` name, and a `command` segment containing `=`.
- `src/plugins/__tests__/resolve-bundled-argv*.test.ts` (existing): policy `"process"`
  expands `${PLUGIN_ROOT}/bin/x` (file) and `${PLUGIN_ROOT}/vendor` (**directory**, the
  P5 acceptance case) and `${PLUGIN_DATA}/state` (not yet existing) to contained absolute
  paths; refuses a missing `${PLUGIN_ROOT}/nope`, a root symlink escape, a data symlink
  escape, and a directory as the executable (revert each branch).
- `out-of-process-plugin.test.ts` (recorded spawn spec, no process: the
  `vi.mock` of `permissions/confined-child.js` S1 introduced records the
  `spawnConfinedChild` call): a process launch spec produces a `spawnConfinedChild` spec
  whose `command` is `/usr/bin/env`, whose
  `args` carry the manifest pairs then `PLUGIN_ROOT=`/`PLUGIN_DATA=` then the resolved
  command and args, whose `baseEnv` deep-equals `buildSafeChildEnv()` and whose
  `extraEnv` has only the sandbox HOME — **no manifest key in either** (move a pair into
  `baseEnv` → fails); with the sandbox reported off the factory throws
  `process-entry-unconfined` before any spawn and the spawn count stays zero (remove the
  check); on `win32` the same (remove the platform clause); a plugin root whose path
  contains `=` refuses the launch before the spawn with the path named, and the spawn
  count stays zero (remove the `=` check); an entry launch is unchanged (assert
  `ELECTRON_RUN_AS_NODE`).
- `plugin-doctor-load-classification.test.ts:48-65` and the runtime suites around it —
  **one case per activation path** (boot preflight, `instantiateAndStartSinglePlugin`,
  `activatePreparedArtifact` with a staged `receiptRaw`, `restartPluginInternal`), each
  twice: a process manifest with a v4 `git` receipt at rung `release` passes the gate and
  reaches the factory (observed as `process-entry-unconfined` in the sandbox-off test
  environment, which distinguishes "admitted, then refused at spawn" from "refused at the
  gate"); the same with rung `tree`, with a v3 receipt, with a `local-dev` receipt under
  dev unlock, and with a valid receipt the path did not verify (`verified` undefined, the
  no-id variants above; not applicable to prepared activation) is refused
  `process-entry-requires-pinned-artifact` with the factory-import hook never reached
  (the subclass seam these tests already use; remove the receipt clause, or drop the gate
  from one caller → that path's case fails). And the **precedence cases**: a process
  manifest with **no receipt** on boot, add and restart is refused by the existing
  receipt refusal — boot and add with an id assert `markReceiptIntegrityFailed` with the
  receipt reason and no manifest read on boot; the no-id variants assert the
  materialisation `ENOENT` — and in every one the gate and the factory-import hook are
  never reached (revert: move the gate before the integrity check → the boot case reports
  the process code for an unverified manifest and fails).
  `install-local.test.ts:102-112`, `plugin-install-failure.test.ts:56`, `:88`,
  `install-result-payload.test.ts:104`, `PluginConfigTab.test.tsx:453` and
  `GitMarketplaceTab.test.tsx:186` move to the new codes, and so do the three marketplace
  sites `plugin-ladder.test.ts:293`, `manifest-rules.test.ts:105` and `sync.test.ts:606`,
  which in P3 assert `process-entry-requires-pinned-artifact` for the still
  unconditional refusal and which P4 rewrites for the admission rule — all eleven of
  fact 4 move in P3, because the old code leaves the closed sets here.
- `confined-plugin-child.test.ts` (macOS and the new Linux job, `AVE_REQUIRE_SANDBOX_CASES=1`):
  (a) a process launch whose `bin/plugin` is a `#!/bin/sh` script that `exec`s the host's
  own `process.execPath` under `ELECTRON_RUN_AS_NODE=1` on the invoker module reaches
  construct under the real wrap and reads `PLUGIN_ROOT`, `PLUGIN_DATA` and a declared
  `SMOKE_VENDOR_DIR` from its environment (remove the `env` prefix → fails); (b)
  **no pre-confinement execution**: a `ConfinedPluginChildSpec` built directly (below the
  hardening) with `env: { BASH_ENV: "<root>/startup.sh" }`, where `startup.sh` writes a
  sentinel file to a temporary directory **outside** the envelope; after the child exits
  the sentinel must not exist — the outer `bash -c` never saw `BASH_ENV`, and inside the
  wrap the write is denied (revert: put the pair in `baseEnv` → the sentinel appears);
  (c) the same with `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES` naming a library in the root
  that writes the sentinel from its constructor. This proves the spawn path and the
  environment only; a real non-JS interpreter is P5's job.
- `host-protocol-schema-parity.test.ts:106-219`, against the **generated** wire schema
  (`protocol.schema.json` `$defs.types.PluginManifest`, compiled with the suite's Ajv):
  the process-launch construct golden validates; an entry-only and a process-only
  manifest validate; a manifest with **both** `entry` and `process` fails, and one with
  **neither** fails (revert: drop the generator's `never` → `false` rule → the both-case
  passes and the test fails; make `entry` optional in `EntryPluginManifest` → the
  neither-case passes and the test fails). A generator case in
  `test/scripts/plugin-host-protocol-schema-never.test.ts` (new) projects a
  two-interface union with a `never` member and asserts the `false`
  subschema, and asserts the generator error for a `never` member of an unexported
  interface.

*Gates.* `bun run typecheck`; `bun run test:vitest -- run src/plugins src/shared
src/ipc/domains src/ui/renderer/hooks/status-bar src/ui/renderer/__tests__/PluginConfigTab.test.tsx
src/ui/renderer/tabs/git-marketplace`; `bun run check:plugin-host-protocol-schema`,
`check:plugin-host-protocol-mirror`, `check:plugin-host-protocol-client`;
`bun run build` (carries `check:i18n-catalog`, `check:i18n-barrels`);
`src/i18n/__tests__/used-keys-exist.test.ts`; naming gate; CI rollup; the macOS **and
Linux** confinement jobs green — the Linux job is created here and is P3's own merge
gate.

*Lock suites.* `channel-inventory`, `host-renderer-only-channels`, `domain-exports`,
`preload-shape` **unchanged**: the refusals travel in the existing `installFailureKind`
value of the plugin-status DTO and the existing install-result channel;
`settings-store` **unchanged** (no setting); `packaging-discipline-source` **unchanged**
(no script). The manifest schema and hardening tests, the public-contract boundary
tests and `host-protocol-schema-parity` change and are named above.

##### P4. The `process` entry: marketplace admission

The rule (§2.1, §7.3): a `process` entry is admitted only for an install whose artifact
came through the **release or archive rung with a sha256 pin**. Tree, direct and local
installs are refused with `process-entry-requires-pinned-artifact`. Two kinds of evidence
are distinguished and both are required (decision 34): the **declared** pins in the
descriptor and index (`artifact.release.sha256` / `artifact.archive.sha256`,
`catalog/types.ts:108-119`), which the static rules below check so the ladder can never
reach the tree rung for such a plugin; and the **verified** rung the ladder actually used,
recorded in the receipt's `git.rung` and read by the zip transaction here and by P3's
runtime gate. The verified rung is what admission trusts; the declared pin is what makes
the verified rung reachable.

The owner's parallel marketplace change (http sources accepted with a warning, local
directory sources, private-network targets as a warning, auto-update; designed on
another branch) does not relax this rule: a `process` entry from any source, http or
local directory included, is admitted only through a sha256-pinned `release` or
`archive` rung recorded in the receipt, so a local directory source (which has no pinned
artifact) is refused like `installLocal`, and an auto-update re-runs the same ladder,
receipt and runtime gate as a first install.

*Files.*

- `src/marketplace/resolve/manifest-rules.ts:33-39`: `ExpectedPlugin` gains
  `platforms?: readonly Platform[]` and `artifact?: PluginArtifactPins` — the extended
  input contract every producer fills: `plugin-ladder.ts:172` from `plan.platforms` and
  `plan.artifact` (`PackagePlan.platforms` at `src/marketplace/resolve/descriptor.ts:32`;
  `PluginInstallPlan.artifact` at `plugin-ladder.ts:44`); `repository-check.ts:97-105`
  from `descriptor.platforms` and `payload.artifact` (`PackageDescriptor`,
  `catalog/types.ts:121`, `platforms` at `:134`, `payload` at `:136`); `:135` from
  `version.platforms` and `version.artifact` (`IndexVersion`, `types.ts:66`, `:71`,
  `:73`). `gitInstallManifestMismatches` (`:66-99`) adds, for a **process** manifest: `platforms` must be present and exclude
  `win32` (so a Windows app never downloads what it cannot run, §6.1 step 3); a declared
  `release` or `archive` pin with `sha256` must exist and `tree` must be absent (so the
  ladder cannot fall to the tree rung); `minAppVersion ≥ PROCESS_ENTRY_FIRST_APP_VERSION`
  (the descriptor's, matching the manifest's floor from P3). All are `MANIFEST_MISMATCH`
  problems naming the field, and stop the ladder. The unconditional throw at `:107` goes.
- `src/marketplace/resolve/plugin-ladder.ts:154-160` (`stagedManifest`): after the staged
  `plugin.json` parses, a process manifest staged from the `tree` rung stops the ladder
  with the new code (defence in depth behind the declared-pin rule; the tree rung is the
  last, so nothing is hidden). The message text at `:156-158` follows the code.
- `src/marketplace/sources/direct-package.ts:118-120`: the code becomes
  `process-entry-requires-pinned-artifact` (a direct install has no pinned artifact by
  construction, §8 of the marketplace design).
- `src/plugins/marketplace.ts:833` (`installZipTransaction`, `:770`): the check becomes the
  receipt rule on the **verified** rung the transaction is committing; `:1029`
  (`installLocal`) refuses with the new code.
- `src/marketplace/errors.ts:37`: nothing — P3 already replaced the code in the closed
  set.
- `src/marketplace/repository-check.ts:267` (`checkMarketplaceRepository`) and
  `checkReleasedManifests` (`:125-139`): the entry kind is decided **per version from
  that version's own released manifest** — process rules (platforms without `win32`, a
  pinned `release`/`archive`, no `tree`, the version floor) apply only to versions whose
  released `plugin.json` has `process`; an older `entry` version that supports `win32` or
  ships by the tree rung is untouched. The source manifest
  (`plugins/<name>/source/plugin.json`) speaks only for the version it names. The
  problem names the descriptor path and the version. The official repository rebuilds
  `tools/vendor/marketplace-check.js` from tag `v0.13.0` (E2′), and `tools/release.mjs
  verify` (official, `validate.yml:55`) keeps holding the built `plugin.json` to the
  descriptor as today.
- **No new descriptor or index field** (decision 34). Format-2 index version
  objects and `pluginAuthority` are closed (`schemas/marketplace/index.schema.json:113`,
  `package.schema.json:415-418`) and a 0.12.0 app drops a package entry whole when
  one of its versions fails a rule (`catalog/validate.ts:11-12`, `:255-256`; decision
  24), so any new field would drop every process-entry package — old versions included —
  from every 0.12.x client. The information a sync needs is already there: `platforms`
  for the Windows refusal before download, `artifact.release`/`archive` pins for the
  rung, `minAppVersion` for the 0.12.x exclusion; the sandbox-off refusal on macOS and
  Linux is pre-activation but post-download (`process-entry-unconfined`), which is stated
  as the cost. A `runtime` field is the first candidate for catalog format 3, if one is
  ever opened.
- `en.ts`, `ko.ts`, `format-ipc-error.ts`, `labels.ts`, `PluginConfigTab.tsx`: nothing —
  P3 added both keys.

*Tests.*

- `plugin-ladder.test.ts:293` and its neighbours: a process manifest inside a pinned
  release zip is staged and installed and the receipt records `git.rung: "release"`; the
  same manifest reached through the tree rung stops with
  `process-entry-requires-pinned-artifact` and the rung list shows `release: skipped
  ARTIFACT_NOT_PINNED`, `tree: failed` (remove the tree clause); the plan's `platforms`
  and `artifact` reach `ExpectedPlugin` (assert on the recorded expected input).
- `manifest-rules.test.ts:105`: the descriptor without `platforms`, with `win32`, with
  only `tree`, or with `minAppVersion: "0.12.0"` is `MANIFEST_MISMATCH` naming the field;
  `platforms: ["darwin","linux"]` with a pinned release and `0.13.0` passes; an **entry**
  manifest with `win32` and a tree rung still passes (remove each problem, or drop the
  entry-kind condition).
- `catalog/__tests__/aggregate*.test.ts` (`aggregate.ts:85-89`): a process-entry version
  with `minAppVersion: "0.13.0"` is excluded `min_app_version` on `appVersion: "0.12.4"`,
  and `platform` on a `win32` 0.13.0 app; the same version is selected on `darwin`
  0.13.0 (assert the exclusion reasons) — the 0.12.x selection regression.
- `sync.test.ts:606`: a process-entry package with a pinned release syncs and is listed;
  on a `win32` app it is excluded by `platforms` (assert the exclusion reason).
- `src/marketplace/__tests__/repository-check.test.ts`: a fixture repository whose
  `alpha` package has `1.0.0` (released manifest with `entry`, `platforms:
  ["darwin","win32","linux"]`, tree rung) and `2.0.0` (released manifest with `process`,
  `platforms: ["darwin","linux"]`, pinned release, `minAppVersion: "0.13.0"`) is
  **clean**; adding `win32` to `2.0.0`, removing its pin, adding a `tree`, or lowering its
  `minAppVersion` → a problem naming `2.0.0`; touching `1.0.0` the same ways → still
  clean (remove the per-version condition → `1.0.0` is wrongly reported).
- `direct-package` and `install-local` tests: the new code (as P3 left them).

*Gates.* `bun run typecheck`; `bun run test:vitest -- run src/marketplace src/plugins`;
`bun run build`; naming gate; CI rollup. After merge, the official repository's
`vendor.mjs verify --app <checkout>` against `main` proves the rebuilt checker's rules
before E2′ pins them (development evidence, not the production pin, §6.3).

*Lock suites.* `channel-inventory`, `host-renderer-only-channels`, `domain-exports`,
`preload-shape`, `settings-store`, `packaging-discipline-source` **unchanged**; the
marketplace DTO tests (`src/shared/git-marketplace.ts`) unchanged because no DTO grows.

##### P5. The cross-language smoke

*Files.*

- `src/plugins/isolation/__tests__/fixtures/host-protocol/2/plugins/python-smoke/`:
  `plugin.json` with `process: { command: "./bin/plugin" }` — **no `env`**: `PYTHONPATH`
  is a reserved name (`safe-names.ts:41`; fact 9), so the launcher sets it itself, inside
  confinement, from the host-owned `PLUGIN_ROOT` — `requires: { hostProtocol: "2",
  minAppVersion: "0.13.0" }`, one tool `echo` with an empty `inputSchema`,
  `eventSubscriptions` and `emittedEvents` empty; `bin/plugin`, a `#!/bin/sh` script that
  sets `PYTHONPATH="$PLUGIN_ROOT/vendor"` and `exec`s the interpreter recorded in
  `bin/python-path` (written by the harness into its temporary copy of the fixture, never
  committed) with `-s` (no user site directory) on `plugin.py` and its arguments;
  `plugin.py`, ~170 lines: a newline-delimited JSON-RPC loop over stdin that routes
  `ave/instance/*` to its own handlers (construct checks `hostProtocol.version == "2"`,
  records the capabilities, answers `implementedToolNames: ["echo"]`,
  `servesUiResources: false`, `lifecycleHooks: ["start", "stop"]`, `pluginProtocol: {
  requires: ["ave/host/storage/read", "ave/host/storage/write"] }` — the full method
  names the host advertises, `hostApiMethodOf` at `host-api-wire.ts:221-222`,
  `hostProtocolCapabilities` at `host-api-dispatcher.ts:210-216`, checked by exact
  membership in `requireServedCapabilities`, `out-of-process-plugin.ts:1118-1121`; start
  writes then reads one storage key through those two methods and emits one
  `notifications/ave/log`; stop answers with a last log notification whose
  `params.meta.ruMaxrss` carries `resource.getrusage(RUSAGE_SELF).ru_maxrss`, and the loop
  exits when stdin ends), settles `ave/host/*` replies against its own pending table, and
  for every other request — `server/discover`, `tools/list`, `tools/call`,
  `resources/read` — **first checks the MCP per-request metadata itself**: a request whose
  `params._meta` lacks `io.modelcontextprotocol/protocolVersion` or
  `io.modelcontextprotocol/clientCapabilities` is answered `-32602` (Invalid params) by
  the plugin, as the specification requires (fact 16), and never reaches the library; a
  request with both is handed to the `mcp` 2.2.0 server kernel in memory, one message at a
  time, so the stock library serves the MCP half at `2026-07-28` (`server/discover` from
  the tools it registered) while the plugin owns the pipes (fact 1). The check is the
  plugin's own so the fixture's strictness does not depend on what the library happens to
  enforce. Anything the plugin logs goes to stderr. `plugin.py --print-mcp-origin` prints
  `mcp.__file__` and exits (the launcher test below). `expected.jsonl`: its golden
  transcript. `README.md` in the fixture names the pinned `mcp` version and the
  interpreter rule.
- `src/plugins/isolation/__tests__/python-smoke-harness.ts` (new): copies the fixture to a
  temporary root and resolves **one** interpreter, in this order:
  - **`AVE_SMOKE_PYTHON`** if set (every CI job but the self-hosted macOS one sets it to
    the interpreter it provisioned, below; that one leaves it unset and takes the uv
    path);
  - otherwise the app's own development uv (`resolveBundledUvBinaryPath`,
    `main/uv-runtime.ts:34`; `resources/uv/<platform>-<arch>/uv`, uv 0.7.3, fact 17),
    with **one environment for every uv invocation**: `UV_PYTHON_INSTALL_DIR=<cache>/python`,
    `UV_PYTHON_BIN_DIR=<cache>/bin`, `UV_PYTHON_INSTALL_BIN=0` and
    `UV_CACHE_DIR=<cache>/uv`, where `<cache>` is `node_modules/.cache/ave-python-smoke`.
    Discovery is `uv python find --managed-python '>=3.10'` — managed installations in
    that directory only, so the first `python3` on `PATH` is **not** consulted (uv's
    default discovery would fall through to `PATH`, fact 17); on a miss, `uv python
    install 3.12` under the same environment and then the same `find`. The install
    directory, the discovery directory and the executable-link directory are therefore
    one tree under `<cache>`: uv 0.7.3 links no executable, a later uv with 0.8.0's
    default links it into `<cache>/bin` (or not at all), and the harness writes nothing
    into the user's home.

  It then **verifies the resolved executable before anything else**: `<python> -c
  'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'` (the `mcp` 2.2.0
  floor, fact 1); installs `mcp==2.2.0` into a vendor directory with `uv pip install
  --python <that executable> --target <dir> mcp==2.2.0` under the same environment (the
  same uv; `--python` names the verified interpreter, so the wheels are the ones it can
  import), cached under `<cache>/<python version>-mcp-2.2.0/` and copied to
  `<root>/vendor`; and proves the vendor directory with `PYTHONPATH=<root>/vendor <python>
  -c 'import mcp, importlib.metadata as m; print(m.version("mcp"))'`, which must print
  `2.2.0` — a **provisioning** check, which proves the wheels, not the launcher. It writes
  `bin/python-path` and records the interpreter path and version, the wheel set and the
  provisioning time in the test output. A missing uv, a too-old interpreter, a failed
  install, a failed import or a network refusal on a cache miss **fails** the test with
  the missing prerequisite named; nothing is skipped (§9.6's discipline: an unavailable
  verification is recorded as such).
- `host-protocol-golden.test.ts`: a `process`-launch recording path — the child is a
  real process on pipes (a Python process cannot run on in-memory streams), spawned
  plainly by the test and attached to `openValidationSession` (S1; **not** the
  production factory, which would demand a live sandbox and pinned provenance and is
  right to). Frames are compared after the same canonicalisation plus **one named
  rule**: in a child `notifications/ave/log` frame, `params.meta.ruMaxrss` is replaced
  by `"<measured>"` after its raw value has been copied into the measurement record —
  RSS varies by run and platform, and a golden that held it would fail on unchanged wire
  behaviour. The rule is keyed to that one path, so any other number still compares
  exactly. **Temporary roots are canonicalised by a second named rule** (cross-language
  re-review round 3, finding 2): this path's plugin root (a `mkdtemp` copy of the Python
  fixture with its `vendor/`) and its data root are not under `FIXTURE_CODE_ROOT`, so
  `goldenPath` (`host-protocol-golden.test.ts:64-66`, `:224-236`) leaves them in place,
  and they reach the wire in construct's `context.pluginRoot`, `context.pluginDataDir`
  and `entryPath` (`out-of-process-plugin.ts:1408-1434`) and in any later frame that
  echoes a path. The recording replaces, in every string of every frame, each root — as
  allocated and after `realpath` (macOS's `/var` → `/private/var`) — with
  `<plugin-root>` and `<plugin-data>`, longest spelling first, and the validation
  context's `hostRoot`, `userHome` and `aveHome` with `<host-root>`, `<user-home>`,
  `<ave-home>`; then, beside `canonicalise`'s existing checkout guard (`:241-265`), it
  throws if `os.tmpdir()` (as given or realpath) or the checkout root still appears
  anywhere in the transcript. **Repeat-run stability** is asserted across **two
  independently allocated roots**: the test records the Python conversation twice in one
  run, each with its own `mkdtemp` plugin and data roots, and requires the two canonical
  transcripts to be byte-equal and equal to the committed golden (drop the `ruMaxrss`
  rule or the root rule → the two differ, or the leftover-path guard throws). The
  transcript is a function of `plugin.py` and of the host's frames — every MCP request
  in it carries the S1 metadata — and a transcript that changes is the wire that
  changed.
- `confined-plugin-child.test.ts`: the smoke runs through the **production factory** — a
  fixture install root with a v4 receipt at rung `release` (P3's gate) under the live
  sandbox on macOS and Linux — with **`observeChild`** (S1) as its only view of the child,
  and passes the §10.1 items: construct/start/tools/call/stop over the real wrap;
  **stdin-close exit** within 5 s with no host request and **no termination call** — the
  case calls `endInput()` and races `exited`, and only after a timeout failure is recorded
  does `instance.stop()` terminate; **stdout discipline** by **raw inspection** (fact 11):
  the case collects `onStdout` bytes and asserts every line is a JSON object; a variant
  `bin/plugin` that prints a bare line before its first frame fails that assertion while
  the decoder still yields every frame, and one that writes a `Content-Length:` header
  fails it the same way — the decoder is not changed and no production rejection is
  introduced (decision 40). **Resource measurement** (decision 41): from spawn to exit
  the harness samples the **process tree rooted at `observeChild`'s `pid`** (the spawned
  wrapper) every 50 ms (`ps -o pid=,ppid=,rss= -A`, descendants of that PID; RSS in KiB on
  both platforms, converted to bytes) and records the peak and the spawn→construct wall
  time for the smoke and for the `meeting` fixture; the Python child's own `ruMaxrss`
  (bytes on darwin, KiB on linux, normalised by platform) is recorded beside it.
  `process.resourceUsage()` is **not** used: it reports the test runner. The numbers are
  reported, not gated, and the UNVERIFIED item stays open until a run has produced them.
- `src/plugins/isolation/__tests__/python-smoke-launcher.test.ts` (new) — **the launcher
  test**: after provisioning, it runs the fixture's real `bin/plugin --print-mcp-origin`
  under `env -i PATH=/usr/bin:/bin PLUGIN_ROOT=<root> PLUGIN_DATA=<tmp>` — no
  `PYTHONPATH`, no `PYTHONHOME`, no `PYTHONUSERBASE` from the harness — and asserts the
  printed path's realpath lies under `<root>/vendor/`. With `PYTHONPATH` dropped from
  `bin/plugin` it fails either way the defect can show: `ModuleNotFoundError` when the
  interpreter has no ambient `mcp`, or a printed origin outside `<root>/vendor` when it
  has one (and `-s` keeps a user site directory from being that ambient copy). This is
  what the second round's "the import check fails before spawn" could not show, because
  that preflight sets `PYTHONPATH` itself.
- `.github/workflows/ci.yml`: **every job that runs the smoke** — `build-and-test`
  (`:11`; its default `bun run test` runs the golden and launcher paths over pipes), the
  macOS job (`:327`) and P3's `linux-confinement-tests` — gains, after `bun install`:
  - `Ensure uv toolchain` (`node scripts/fetch-uv.mjs`, exactly the step of `:68-74`)
    in the macOS and Linux confinement jobs, which lack it (fact 17), so a restored
    `node_modules` cache cannot leave the harness without uv; `build-and-test` already
    has it;
  - an `actions/setup-python` step with `id: python` (SHA-pinned like the other actions;
    `v7.0.0` is the current release, 2026-07-20) and `python-version: "3.12"`, exporting
    `AVE_SMOKE_PYTHON: ${{ steps.python.outputs.python-path }}` to its test step
    (`python-path` is the action's documented output, "The absolute path to the Python or
    PyPy executable", <https://github.com/actions/setup-python/blob/main/action.yml>,
    checked 2026-09-28). The macOS job runs on the owner's self-hosted machine
    (`AVE_MACOS_RUNNER`), where `actions/setup-python` installs a `.pkg` with
    `sudo installer -target /` into `/Library/Frameworks`; it has no such step and
    the harness provisions a managed 3.12 with uv under its cache instead.

  No job relies on the runner image's `python3`. Setting the variable skips the uv
  discovery above but **not** the version check, the uv package install or the import
  proof, which is what proves the provisioning; so a broken smoke fails every push.
- `knip.jsonc:47-50`: the fixture glob already covers `*.mjs` under
  `fixtures/host-protocol/*/**`; `plugin.py` and `bin/*` are not JavaScript and need no
  entry.

*Tests (the smoke is the test).* Revert targets: delete `server/discover` handling in
`plugin.py` → the CLI probe in P2's suite and the golden's discover frame fail; make
`plugin.py` ignore stdin end → the stdin-close case fails; print to stdout → the raw
discipline case fails while the decoder count stays the same (which is the proof the raw
check is needed); drop `PYTHONPATH` from `bin/plugin` → the launcher test fails (the
import error or the non-vendor origin, above), and the confined case fails at construct;
remove the P3 `PLUGIN_ROOT` variable → `bin/plugin` cannot find `vendor` and construct
fails; remove the S1 metadata producer → every MCP request of the Python golden is
answered `-32602` and the golden and the confined case fail; delete the metadata check
from `plugin.py` → the golden path's case that writes one raw `tools/call` frame without
`_meta` on the pipe the test owns (not through the session, whose `requestMcp` always
stamps it and whose `probe` refuses MCP methods) and expects `-32602` fails; drop the
`ruMaxrss` rule or the temporary-root rule → the two-root repeat-run assertion fails;
remove the `Ensure uv toolchain` step from a confinement job on a cache hit → that job
fails with the resolver's "bundled uv binary not found" (`uv-runtime.ts:58-62`); point
`AVE_SMOKE_PYTHON` at a 3.9 → fails at the version check.

*Gates.* `bun run typecheck`; `bun run test:vitest -- run src/plugins/isolation`
locally (provisions once per run); `bun run build`; naming gate; CI rollup **plus** the
macOS and Linux confinement jobs green.

*Lock suites.* All six **unchanged**: fixtures, a harness and CI steps add no channel,
export, bridge method, setting or package script.

##### E1′. The 0.13.0 release PR

As Lease's E1 (§9.6), minus the bump #2589 already made: `scripts/release.mjs` with
`AVE_RELEASE_VERSION=0.13.0` keeps the version, regenerates the schema and the client
at the final commit and refreshes the `2/v0.13.0` candidate (the `2/v0.12.0` copy is
untouched), and the PR carries the `CHANGELOG.md` entry ("`process` extensions run under
the OS sandbox on macOS and Linux; a validate command for extension authors; the protocol
client") and the `x-ave-app-version-range` note if §6.4 still wants one. It also
carries the alerts gate the release process already imposes on the 0.13.0 draft
(`docs/development/release-process.md`, "Include the new-mail and meeting-summary
opt-in loss": the draft stays unpublished until `local-indexer` has published on the
alert contract), which is not Publication's but is on the same draft. Gates: the full
suite and build once on the merged tree; fresh CI on the rollup including the two confinement jobs;
`check:plugin-host-protocol-mirror` with exactly one candidate and
`check:plugin-host-protocol-client` clean; packaged smoke per OS. Lock suites:
`packaging-discipline-source` only for the version-carrying assertions it already has.
Nothing in E1′ depends on tag `v0.13.0` existing.

##### E2′. After the tag: plugin repositories and the mirror

Gates on the published release, not inputs to creating the tag:

1. **Official repository** (`ken-jo/agent-marketplace`), **after the candidate wave**
   (`feat/lease-candidates`, `e53fb40a8`) has merged: the validation targets are the
   tracked sources that remain — `hello-world`, `local-indexer`, `meeting`, `mail`
   and `templates/extension` — because the wave's `0835fd2` deleted
   `plugins/assistant/source` and kept its catalog entry and revocation (fact 6;
   decision 42). Then `node tools/vendor.mjs sync contract --ref v0.13.0 --app
   <checkout>` adds `schemas/plugin-host-protocol/2/protocol-client.ts` to
   `contract/sources.json` (beside the schema Lease added) and refreshes the copies;
   `node tools/vendor.mjs sync tools/vendor --ref v0.13.0 --app <checkout>` rebuilds the
   wave's two bundles (`marketplace-check.js`, `agent-plugin-components.js`) and adds two
   more **with the post-wave recipe** (fact 17), each a `tools/vendor/sources.json` entry
   of exactly the wave's shape: `"ave-plugin-validate.js": { "build": { "entry":
   "src/plugins/validate/cli.ts", "bun": "1.3.14", "logger": "stub-app-logger" },
   "sha256": … }` and `"ave-plugin-child-main.js": { "build": { "entry":
   "src/plugins/isolation/plugin-child-main.ts", "bun": "1.3.14", "logger":
   "stub-app-logger" }, "sha256": … }`, built by `buildAtRef` (`vendor.mjs:90-107`), which
   evaluates `tools/bundle-app-marketplace.mjs` with `bun -e` from the app checkout at
   the tag. The logger behaviour is intended, not incidental: the host logger is
   silenced in both (P2, "Logger behaviour in the bundles"), and `checkVendored`'s
   embedded-path rule (`vendor.mjs:37-43`, `:71`) holds them like the checker — P2's
   bundle test runs this exact recipe, so a bundle the official repository cannot build or
   verify fails in ave before the tag. The recipe's comment and error texts say
   "checker bundle"; that wording is the official repository's to generalise and changes
   no bytes. In the same PR **the drift
   scripts are retired**: `plugins/{local-indexer,meeting,mail}/source/scripts/validate-hostapi.mjs`,
   `templates/extension/scripts/validate-hostapi.mjs` and their `ui-bridge-usage.mjs`
   helper are deleted, each `validate:hostapi` script becomes
   `node ../../../tools/vendor/ave-plugin-validate.js .` (the template's path adjusted),
   and the workflow step at `validate.yml:111-118` runs the CLI for **every** discovered
   directory unconditionally instead of only where a script exists — a plugin that cannot
   be validated is a red run, not a skipped step; with the retired source gone, no
   discovered directory is one the CLI must refuse by design. `validate:events` stays
   until the CLI's event check has run green for one release, then follows. `tools/repo.mjs`
   and `tools/index.mjs` need no change (no descriptor field). If the wave has **not**
   merged when the tag exists, this item waits for it; the mirror promotion (item 3) does
   not.
2. **the portal and repository plugins** cannot take a bundle today (fact 6). Each repository's tool
   (`portal` `tools/contract.mjs`; `git` `tools/vendor.mjs`) gains a **`build` entry kind**
   with the semantics of the official repository's **post-wave** `buildAtRef`
   (`e53fb40a8:tools/vendor.mjs:90-107`), not the pre-wave plain `bun build` that
   `6a4d3b3`'s `:77-91` describes: the entry records `{ entry, bun, logger:
   "stub-app-logger" }` and any other `logger` is refused (`:92`); the bundle is produced
   by a byte-identical copy of `tools/bundle-app-marketplace.mjs` (pinned in each
   repository by the sha256 of the official file at the wave, and verified against it)
   evaluated with `bun -e` from the `--app <checkout>` at the pinned tag, clean and at
   that tag; the bun version is recorded beside the sha256 of the output; `verify`
   rebuilds and compares bytes and applies the embedded-path rule. The GitHub-contents
   path stays for copies only, so `verify` of a bundle **requires** an app checkout.
   Inventories: `portal`'s exact count (`:18-30`) grows to the
   schema (Lease) plus the client under `contract/`, and a new `tools/vendor/` set with
   `ave-plugin-validate.js` **and** `ave-plugin-child-main.js` (the CLI spawns the
   second for `entry` plugins, P2); `git`'s `sources.json` the same. Their verification
   workflows (`git` `contract-verify.yml`; `portal`'s equivalent) gain a checkout of ave
   at the pinned tag, `setup-bun` at the recorded version and `bun install
   --frozen-lockfile` in that checkout before `verify`. Each repository's CI adds a
   **bare-Node CLI smoke**, `node tools/vendor/ave-plugin-validate.js .` after its
   build, and `portal`'s Ajv `validate:manifest` and `git`'s `check:manifest` become that
   command.
3. **Mirror promotion** (M1 merged first): `node scripts/sync-plugin-host-protocol-mirror.mjs
   --publish 2/0.13.0` in a `web`-only PR sets `2/v0.13.0`'s `publishedTag: "v0.13.0"`
   and writes alias `2` and `2/protocol.schema.json` as the newest published copy of
   protocol `2`; the check enforces that whether Lease's `2/v0.12.0` promotion has landed
   before, lands after, or never lands (§6.1, decision 39) — and if it lands after, it
   sets `publishedTag: "v0.12.0"` and leaves the alias at `v0.13.0`.

#### The §10.1 conformance items this step owns

| Item | Owner | What Publication adds |
|---|---|---|
| 1. Schema ↔ dispatcher parity | Wire step (`host-protocol-schema-parity.test.ts:106-219`) | P1: the client held to the same schema by bytes and by an isolated compile with type equalities; P3: the process-launch construct golden validated against the regenerated schema |
| 2. Golden fixtures | Wire step (`host-protocol-golden.test.ts`) | S1: self-contained fixtures over the validation-only session, every MCP request frame carrying the required metadata; P5: a golden recorded over real pipes for a non-JS `process` plugin |
| 3. Real confined child | Wire step (`confined-plugin-child.test.ts`; stdin-close at `:1833`) | S1: the existing stdin-close and stdout cases observe the production factory's own child through `observeChild`; P3: a process launch under the real wrap with the environment applied inside it and the pre-confinement negatives, on macOS **and Linux**; P5: stdin-close without termination, raw stdout discipline and child-tree measurement for a process entry |
| 4. Adversarial fixture | **Admission** (not 0.13.0) | P3 leaves the launch path and the provenance gate it will attack; P4 leaves the admission rule it must not bypass |
| 5. Cross-language smoke | **Publication** | P5, passing 1-3 as read above |

#### What Publication leaves ready for Admission

- A launch path that is already out of process by manifest shape (P3), so "out of
  process by default for every install" becomes a change to `importPluginFactoryForLifecycle`
  (`runtime/index.ts:5150`) alone: route every `entry` plugin like a `process` one and
  delete the census; the factory, the session layer, the envelope and the dispatcher need
  nothing new.
- A factory with exactly one way to obtain a child (S1), so the adversarial fixture
  attacks the production spawn and cannot be pointed at a seam; its one test seam,
  `observeChild`, sees the child only after the wrap and can replace nothing.
- The provenance gate on every activation path with the rung in the evidence (P3), and
  the two refusal codes and their Doctor texts (P3, P4), which the adversarial fixture
  will exercise from the marketplace side (a tree-rung process entry, a Windows install,
  a hand-placed directory).
- The validate CLI (P2), which is the harness the adversarial fixture is written against
  first — its four escapes are `ave/host/*` and filesystem attempts the validation host
  records — before it runs under the real wrap.
- The `git` prerequisites of decision 22 are unchanged by this step and stay Admission's.

#### Gates common to every slice

`bun run typecheck`; the narrow `bun run test:vitest -- run <dirs>` named per slice while
iterating, then the full `bun run test` and `bun run build` once on the main + PR merged
tree before merge (the pre-push hook runs its fast tier, `scripts/hooks/run-local-checks.mjs`); `check:knip:engine` against its
baseline where a file or script is added; `.github/scripts/naming-gate.sh origin/main
HEAD` with GNU grep; CI `build-and-test` and `naming-gate` green on the check rollup
before merge, the macOS confinement job for S1, and the macOS and Linux confinement jobs
for P3 and P5 (the Linux job exists from P3 on). No slice merges
with a `test.skip`, a stub fixture or an unimplemented branch standing in for evidence.

### 9.8 The Admission step: implementation plan

Scope is the "Admission" row of §9.1, shipping in app release **0.14.0**, plus the
host side of retiring the old marketplace server (marketplace design §16; the "P7"
item of `TODO.md`). Every citation in this section is
ave at `c4c9689d2` (main, 2026-10-02: after **#2616**, the last marketplace §18
slice; after the `v0.13.0` tag at `ca6e3aa77`, #2605) unless a repository is named;
`ave-plugin-repo` is cited at its `origin/main` `d71fb9553` (unchanged since §9.2 cited
`d71fb95`), the official repository
`ken-jo/agent-marketplace` at its `main`, `6a4d3b3df` (still private; the remote has
only `main`, so the candidate wave of §9.7 fact 6 is unpublished), and the blueprint at
`docs/blueprints/plugin-process-isolation.md` on the same ave commit.

Plugins that are not in the official index publish through another marketplace
source and their own CI. That plugin-side work is planned outside this document
(decisions 48 and 49); the host slices do not depend on it.

What Admission changes for a plugin author: nothing in the contract. A protocol-2
`entry` plugin that runs in process today gets the same `PluginHostApi` from the
reference runtime in its own process (§2.1); what stops working is what was never in
the contract — ambient egress, a home-relative path, Electron, the host's heap — and
`git` is the one known plugin that relied on two of those (decision 22).

#### Facts this plan rests on

Verified on 2026-10-03, each with the source that proves it.

1. **Publication landed whole, and 0.13.0 is tagged.** S1 #2594, P1 #2595, P3 #2596,
   P2 #2597, P4 #2599, P5 #2600 are on `main` (`git log --first-parent`); the release PR
   #2605 merged as `ca6e3aa77` and carries the annotated tag `v0.13.0`
   (`git ls-remote --tags`); `package.json` is still `0.13.0`; `mirror.json` holds
   `2/v0.13.0` as the candidate (`publishedTag: null`, `generatedFrom: ee7fcbc04`) and
   `2/v0.12.0` still unpublished. E2′ has not run: no Actions run exists on
   `ken-jo/ave` since 2026-09-22. The marketplace §18 slices B–G (#2602,
   #2606, #2607, #2613, #2614, #2615, #2616) are on `main` too, so folder sources,
   policy `additional[]`, `requiredInstalls` binding and automatic updates exist in the
   tree this plan builds on.
2. **The routing function today.** `importPluginFactoryForLifecycle`
   (`src/plugins/runtime/index.ts:5249-5310`; the abstract declaration at `:3602`) runs,
   in order: `assertPluginLifecycleAvailable`; `assertProcessEntryAdmitted(manifest,
   verified)` (`:5260`, decision 35); the kind check against `pluginEntryKind`
   (`:5261-5263`); the `process` branch, out of process by manifest shape
   (`:5271-5283`); then **the census**: `if (isOutOfProcessPlugin(pluginId))`
   (`:5284`) returns `createOutOfProcessPluginFactory({ ...outOfProcess, launch: { kind:
   "entry", entryPath: source.resolvedEntryPath } })` (`:5291-5294`), and everything else
   falls to `runPluginImportWithTimeout(() => importPluginFactory(resolvedEntryPath,
   bustCache))` (`:5298-5299`) with quarantine on `PluginImportTimeoutError`
   (`:5302-5305`). Its four callers pass `bustCache` (`:4056`, `:4962`, `:5624`,
   `:6374`, the restart passing `true` at `:6380`). The census is
   `OUT_OF_PROCESS_PLUGIN_IDS` (`src/plugins/isolation/out-of-process-plugins.ts:875-877`:
   `assistant`, `mail`, `local-indexer`, `meeting`, `portal`),
   `isOutOfProcessPlugin` (`:880-882`) and `allPluginsAreOutOfProcess` (`:891-898`); its
   only production importer is `runtime/index.ts:68` → `:5284`. `importPluginFactory` is
   `src/plugins/runtime/plugin-loader.ts:77-86` ("ELECTRON-FREE, and that is
   load-bearing", `:73-76`), imported by `plugin-child-main.ts:31` (used at `:230`) and
   by `runtime/index.ts:66` (used at `:5299` only; the same import line brings
   `buildImportUrl`, `buildMethodMap` and `declaredAppVisibleToolMethods`, which main
   keeps using — `buildImportUrl` at `:2249`). `runPluginImportWithTimeout` (`:1204`)
   and `PluginImportTimeoutError` (`:1174`) have no other caller. The test pins:
   `host-api-boundary-contract.test.ts:306-344` (the frozen set, `isOutOfProcessPlugin`
   per id, `allPluginsAreOutOfProcess` truth table), `floating-surface-resolver.test.ts:84`,
   `:260` (asserts the resolver does **not** branch on routing),
   `boot-preflight.test.ts:230-233` (takes "one id in `OUT_OF_PROCESS_PLUGIN_IDS`" as the
   isolated plugin) and `out-of-process-routing.test.ts`.
3. **The factory, and what "unwrapped" means.** `createOutOfProcessPluginFactory`
   (`out-of-process-plugin.ts:1074`) refuses a `process` launch with no live sandbox or on
   Windows (`:1087-1089`, `ProcessEntryUnconfinedError`), derives the envelope once
   (`:1098-1106`) and obtains its child only through `spawnConfinedPluginChild`
   (`:1111-1122`); `observeChild` is its one seam (`:1047`, `:1133-1135`, decision 43).
   The header (`:10-21`) states the rule Admission inherits: "THE CHILD IS CONFINED
   EXACTLY AS MUCH AS THE HOST'S WORKERS ARE" — `features.pluginWorkerConfinement`
   (`src/data/settings-defaults.ts`, `false`; `src/boot/steps/sandbox-gate.ts:20`; before
   the 0.14.1 split this was `features.osToolSandbox`, which now covers host shells only)
   off means an `entry` child is spawned unwrapped and nothing marks it confined. The
   `userChosenDirectory` resolver (`resolveUserChosenDirectory`, `:395-480`) refuses a
   non-string (`:405`), a non-absolute value — "A leading `~` lands here" (`:408-427`) —
   a value that would re-open `~/.ave/secrets` through an approved `~/.ave`
   (`:437-447`), a ceiling subtraction (`:462-468`) and a path outside the approved
   directories ("approve the directory in the host first", `:472-480`), each through
   `rejectEnvelopeGrant` (`:194`) as `PluginSandboxGrantError` (`:187`) at spawn. The
   manifest `sandbox` block (`schemas/plugin-manifest.schema.json:1017-1115`) has
   `read[]` of kind `hostDirectory` or `userChosenDirectory` and `write[]` of kind
   `userChosenDirectory` only, each `{ kind, configKey, why }`, at most 8 per list.
4. **The validate CLI and the validation host.** `src/plugins/validate/` holds `cli.ts`
   (`--child-entry`, `--child-exec-arg`, `--tool-args <file.json>`, `--fast`, `:10-18`),
   `validate-plugin.ts` (rows `manifest.schema`, `manifest.entry`, `manifest.process`,
   `manifest.host-protocol`, `manifest.min-app-version`, `protocol`,
   `protocol.construct`, `protocol.unknown-method`, `protocol.stdin-close`,
   `protocol.teardown`, `lifecycle.stop`, `sandbox.grants`, `source-drift`),
   `validation-host.ts` (the members are recorded doubles — `getSecret` answers
   `"the-stored-secret"` for any key, `:190-195`; `validationConfinement` is the base
   envelope and throws if asked for config, `:323-340`), `validation-session.ts`,
   `validation-child-link.ts`, `report.ts` (passed / failed / not exercised,
   `:21-45`) and `source-drift.ts`; the script is `plugin:validate` (`package.json`).
   The validator never confines (decision 30), so a filesystem or socket probe inside a
   validated plugin succeeds on the author's machine; what the validator can prove about
   an escape is the plugin's own Node-level outcome and the host calls it records.
5. **The confined-child suite and CI.** `confined-plugin-child.test.ts` gates its live
   cases on `asrtCanInitialize()` and `AVE_REQUIRE_SANDBOX_CASES=1` (`:236-240`); its
   describes run from `:813` to `:2954`. CI has `build-and-test` (`ci.yml:11`),
   `windows-permission-tests` (`:247`), `macos-permission-tests` (`:346`) and
   `linux-confinement-tests` (`:423`: bubblewrap, socat, ripgrep at `:447`, the sysctl at
   `:455`). Branch protection on `main` requires `build-and-test` and `naming-gate` only
   (`gh api …/branches/main/protection`, 2026-10-03); the owner action §9.7 P3 named —
   making `linux-confinement-tests` required — is still open.
6. **`git` at `d71fb9553`.** Two global `fetch` sites: `src/hostPlugin.ts:797` inside
   `fetchTextAllowHttp` (`:792-817`; `fetchText` `:784`, `fetchJson` `:819`), which sends a
   `Cookie` built by `cookieHeaderFor` (`:768-782`) from the in-memory `githubCookies` /
   `gitlabCookies` the plugin harvests itself from `openAuthWindow` (`:2194`, `:2251-2259`,
   `:2306`, `:2349-2358`; partitions `persist:plugin-auth:ave-plugin-repo:github` `:47` and
   a GitLab one at `:51`) and `Authorization: Bearer <githubApiToken>` from
   `githubApiAuthorizationHeader` (`:573-577`, reading its own namespace through
   `getSecret`, `:566`); and `:927` inside `callPluginLlm` (`:897-965`; `api-key` or
   `Bearer` from the plugin's `llmApiKey` secret, `:920-922`, endpoint from
   `llmEndpoint` config, `:903`), reached from `callGitLlm` (`:967-976`, which otherwise
   calls `hostApi.callLlm`). `hostFetch` appears zero times. `readConfiguredDataDirectory`
   (`:824-834`) expands `~` with `os.homedir()` (`:828`) and refuses a non-absolute result
   (`:831`); the cache writes under it with `mkdir`/`writeFile` at `:1140`, `:1155`,
   `:1161`, `:1172` (`saveGitDataCache` `:1129`; readers `:1084`, `:1196`). The manifest
   (`plugin.json`, `name: ave-plugin-repo`, `0.2.1`) declares `requires: { minAppVersion:
   "0.7.0" }` with **no** `hostProtocol`, no `networkAccess`, no `sandbox`, `auth` with
   `partitionDomains` naming a GitLab host, and `configSchema.properties.dataDirectory`
   (`type: "string"`, default `""`, "Absolute directory where Ave Git stores …"); it still
   carries the retired `installPolicy` and `publisher` fields (the loader drops them with a
   warning; the repository check refuses them by name, marketplace design §16.4). Its
   tests are `scripts/*.test.mjs` under `bun test`; CI is `.github/workflows/ci.yml`
   (contract check, encoding and reduced-motion gates, `check:manifest`, typecheck, test,
   build, `check-artifact`), and `publish.yml` / `release-dispatch.yml` publish **to the
   old server** through `former_org/.github`'s `marketplace-publish.yml` on a
   `main` push that changes `plugin.json` (`release-dispatch.yml`, "push to main touching
   plugin.json → … → repository_dispatch(publish-marketplace)"). `contract/sources.json`
   pins two files and `tools/vendor.mjs` only copies (`:76-83`, `:106-113`). Draft PR #27
   (`chore/host-protocol-2`, 0.2.2, `1ebc6b9`) is open and held. Tags end at `v0.2.0`,
   GitHub releases at `v0.1.8`.
7. *(Withdrawn: plugin-side detail, not part of the host design.)*
8. *(Withdrawn: plugin-side detail, not part of the host design.)*
9. **What a custom source must carry.** The app reads a git source's format-2 `marketplace.json`
   only (`MARKETPLACE_INDEX_FILE` in `src/marketplace/catalog/types.ts`, read by
   `sources/snapshot.ts`, `repository-check.ts` and, at the end of a folder path,
   `net/source-input.ts`) and
   `policy/revocations.json` (`snapshot.ts:86`); descriptors are `ave-package.json` with
   `schemaVersion: 2` (`catalog/types.ts:121-136`: `kind`, `name`, `version`,
   `minAppVersion`, `hostProtocol?`, `platforms?`, display fields, `payload`), and an index
   version carries `version`, `commit`, `minAppVersion`, `hostProtocol?`, `platforms?`,
   `authority?`, `artifact?`, `publishedAt` (`:62-75`). `artifact.release` may be `{ url,
   sha256 }` with no `repo`/`tag`/`asset` (`catalog/validate.ts:244-247`); the ladder then
   downloads that URL directly and verifies the pin (`resolve/plugin-ladder.ts:299-300`,
   `verifyPinned`), uses the GitHub REST asset path only for `github.com` with a token
   (`:303-311`), and `archive` is `{ url, sha256 }` (`:316-319`). A catalog-supplied
   target on the source's own host inherits the source's confirmations (§18.2.3).
10. **The official repository is not a home for these two.** `tools/check.mjs:88-91`
    requires an official plugin to ship "as a release asset only (no tree or archive
    rung)" from `REPOSITORY` (`tools/repo.mjs:13`, `ken-jo/agent-marketplace`), and
    `tools/release.mjs verify` holds each released `plugin.json` to the source committed
    at the tag (`:54-58`, `:206-213`): an index entry for `git` would mean moving its
    source into the official repository. The owner declined on 2026-10-03 (decision 48).
    The repository's daily `validate` run (`.github/workflows/validate.yml`, job
    `published`, `:140-160`) has failed every day since 2026-09-25 (runs 36090539502 …
    36960604551) at `git clone --quiet --filter=blob:none
    https://github.com/ken-jo/ave.git` with "fatal: could not read Username
    for 'https://github.com'": anonymous access to a repository the API reports as
    `visibility: public` returns 404 (`curl` 2026-10-03), which is the organization flag
    `TODO.md` records, not a defect in the job.
11. **The old server and its publication path.** `marketplace.former-site.invalid` is
    `former_org/agent-marketplace` (FastAPI, Docker Compose + Nginx under `deploy/`,
    on the owner's own Cloudflare and server; not archived at the time, last push 2026-09-19). Plugin
    repositories publish to it through `former_org/.github/workflows/marketplace-publish.yml`
    (siblings `plugin-ci.yml`, `validate-plugin-manifest.yml`). Nothing under `src/` or
    `web/` in ave names the host any more (grep 2026-10-03); the app has read only git
    sources since #2550–#2558 (marketplace design §16.2, §16.4).
12. **How an installed package reaches a new source, as built.** A registry entry that
    matches no official package — the old server's `portal` and `ave-plugin-repo` installs
    — keeps running as "source unknown — no updates", with the one-time boot notice "<name>
    is no longer managed by Ave. Your organization can keep it up to date by registering
    its marketplace" (marketplace design §16.3, recorded in
    `packages/legacy-migration.json`, §16.4); a managed `additional` source plus
    `requiredInstalls` binds it after the next boot (§16.3; slice F #2615 applies required
    installs), and a user who adds the source and installs the package performs an
    ordinary source switch (§16.4). `defaultInstalls` **skips** an existing package that
    is bound to no source (`src/marketplace/boot-installs/run.ts:219-225`), so it cannot
    rebind an old-server install; an existing install — unbound, or bound to another
    source — that a policy requires is switched through the idle apply queue after boot,
    not by an immediate boot install (`run.ts:199-200`; the `switch` candidate is built
    for a required package whose install is bound to another source or to none,
    `src/marketplace/app/service.ts:2242-2250`). A `git` 0.2.1 install declares no
    `hostProtocol`, so it has been refused before activation since 0.12.0 with the update
    path in its status (decision 9), and `portal` 0.23.0 already runs out of process. **What
    does change arm:** a protocol-2 `entry` plugin outside the census — any third-party,
    folder or direct install, and `git` 0.3.0 on 0.12/0.13, which G1 designs for both
    arms — runs in process today (`runtime/index.ts:5284` falls through) and may depend
    on ambient capabilities; on 0.14.0 it becomes a child. Only `2` is served
    (`host-api-wire.ts:56`), and boot and add refuse an undeclared or unserved version
    explicitly (`markIncompatibleHostProtocol` at `runtime/index.ts:5568` and `:3959`;
    the factory's `IncompatibleHostProtocolError` is routed to
    `refuseIncompatibleHostProtocol` at `:5692` and `:4142`), but prepared activation
    (the lookup at `:4962`, in the method `:4891` names "prepared artifact activation")
    and restart (`restartPluginInternal`, `:6218`, the lookup at `:6374`) reach the
    routing function without that gate, and manifest validation only checks the field's
    format when present (`src/plugins/runtime/manifest-validation.ts:1430-1436`); after
    A1 every path ends in the child factory's own check (`connectionHostProtocol`,
    `out-of-process-plugin.ts:1057`, called at `:1085`), which is what closes those two
    routes. That check runs **inside the returned factory**, not at lookup: the catches
    around the lookup (`:4969-4976`, `:6383-6388`) never see it; the runtime invokes the
    factory later (`createPlugin(…)` at `:5021` and `:6422`, under
    `runPluginFactoryWithTimeout`, which races the factory's own promise without
    re-wrapping its rejection, `:1232`, as `runPluginLifecycleHook` does, `:2219`) and
    the error reaches the invocation catches at `:5141` and `:6443`, which today clean
    up and report generically. The prepared activation rethrows (`:5165`) through
    `src/plugins/marketplace.ts:956` — the install flow's one call of the runtime's
    activation — to the apply queue, whose `failureRecord` stores a non-marketplace
    error as `{ code: "unavailable", message }` (`src/marketplace/app/background.ts:148-153`)
    in `~/.ave/marketplaces/updates.json` (`src/marketplace/updates/history.ts:2`,
    `:54-59`), shown by `UpdatesCard.tsx:609-620` as if the source were unreachable;
    the restart returns `"failed"` (`RestartPluginResult`, `:1680`) and only logs
    (`:6454`; `logPluginLifecycle` writes a log and nothing else,
    `src/plugins/lifecycle-log.ts:140-146`); and the card copies a classification only
    for `loadStatus === "failed"` (`:7564-7568`), which a running incumbent never is.
    Neither path stops the running generation: the prepared activation checks
    `committed` (`:5148`) and discards only the new generation (`:5149-5164`); the
    restart builds its replacement beside the incumbent (`:6226`), discards only the
    replacement (`:6444-6453`) and swaps on commit alone (`replaceRuntime`, `:6529`).
    A1 makes those two catches report the refusal — the transport of each path is in
    "What a user sees on upgrade".
13. **The web author page is behind the catalog format.**
    `web/app/docs/marketplace/authors/page.tsx:27-55` documents `marketplace.json`,
    `schemaVersion: 1` and GitHub release assets; decision 24 made the format-2 index
    the file a 0.12.0+ app reads and fact 9 shows a `{ url, sha256 }` pin is accepted. A
    custom source written from that page would not be read.

#### The four escapes, stated as assertions

Blueprint Stage 9 (`plugin-process-isolation.md:1070-1080`) names them: read
`~/.ave/secrets/`, direct network egress, `require("electron")`, monkey-patch a host
internal (`:38-47` for what each meant in process; `:517-521` and `:949` for what the
child removes, including that `import("electron")` resolved to an inert namespace in the
old arm). One fixture attempts all four, on two harnesses with different claims:

| Escape | In the fixture | Under the real wrap (the gate: macOS and Linux. Windows is measured on a provisioned host, not gated in CI (§9.8 A2), and there plugins are confined against the host only, not against each other — decision 64) | Under the validate CLI (the authoring harness) |
|---|---|---|---|
| 1. `~/.ave/secrets/` | (a) `fs.readdir`/`readFile` of `<AVE_HOME>/secrets` and of another plugin's data directory; (b) `getSecret("plugin.<other>.key")`, with `getSecret("plugin.<self>.key")` as the positive control; (c) a declared `sandbox.write` `userChosenDirectory` grant on `configKey: "escapeDir"` whose config value the test sets to `<AVE_HOME>/secrets` | (a) fails with the substrate's filesystem error (`EPERM`/`EACCES` on macOS, `ENOENT` under bubblewrap, asserted per platform) and returns no bytes; on Windows the secrets sentinel is refused against the host, but another plugin's data is not a gated claim (decision 64) — the control reads the same sentinel file from the test process; (b) **there is no wire error for a denial**: the production `getSecret` audits `hostSecret_denied reason=<tier reason> key=<prefix>`, increments the counter and returns `null` (`src/boot/steps/plugin-runtime/host-api-factory.ts:984-987`), and the dispatcher passes that result through unchanged (`src/plugins/isolation/host-api-dispatcher.ts:746-749`) — so the assertions are: the call resolves to `null`, the sentinel's bytes appear nowhere in the child's result or stdout, the denial audit line is recorded under the identity bound at spawn (the fixture's id, not `<other>`), and the own-namespace control returns the stored value (tier 1 of `runSecretGate`, `src/plugins/secret-access/secret-gate.ts:191-194`); the real-wrap run uses the production secret gate and network guard, never the validation host's doubles; (c) the spawn is refused with `PluginSandboxGrantError` naming `escapeDir` (`out-of-process-plugin.ts:437-447`) and no child exists | (a) reported by the fixture's tool result, `outcome: "unconfined"`, never asserted (decision 30); (b) the validation host answers `"the-stored-secret"` for any key (`validation-host.ts:192`), so nothing is asserted beyond the transcript recording the foreign key — the probe is live; (c) `sandbox.grants` row `not exercised` (P2) |
| 2. Direct egress | `net.connect` and global `fetch` to a loopback listener the test owns, and `hostFetch` to a host outside the manifest's `allowedDomains` | the listener records no connection (macOS network deny, bubblewrap `--unshare-net`, srt-win network confinement) and the fixture reports the connect error; `hostFetch` is refused by the allow-list before any socket, by the guard's existing code — the control connects from the test process | the raw probes are reported, not asserted; the `hostFetch` call is recorded with its URL |
| 3. Electron | `createRequire(import.meta.url)("electron")`, `import("electron")`, `process.versions.electron`, and a planted `vendored-electron/index.js` loaded through its explicit path — never a package under the fixture's `node_modules`, where the bare specifier would resolve it and contradict the `MODULE_NOT_FOUND` claim (`confined-plugin-child.test.ts:418` keeps the same separation) — each form separately (blueprint `:949`), followed by actual uses: `new BrowserWindow()`, `session.defaultSession`, `ipcMain.handle` | the child is `process.execPath` — the Electron binary — under `ELECTRON_RUN_AS_NODE=1` (`out-of-process-plugin.ts:678-690`), staged under a temporary plugin root outside the checkout (as `confined-plugin-child.test.ts:304-308` stages its fixtures, so no `node_modules/electron` is reachable by walking up), so the claim is **no usable main-process API**, never an absent version or a failed import: `process.versions.electron` is a string (the trap a version check falls into), `require("electron")` is `MODULE_NOT_FOUND`, the planted entry exports a path string with `BrowserWindow` `undefined`, `import("electron")` resolves to an inert namespace whose `BrowserWindow`, `session`, `ipcMain` and `app` are `undefined`, and each use throws — the shapes `confined-plugin-child.test.ts:1487-1515` already measures, reused. **The positive control is a separate full Electron main process**, never the test process: the test process itself runs under `ELECTRON_RUN_AS_NODE=1` (`scripts/run-vitest-under-electron.mjs:154`, as `scripts/assert-electron-node-vitest.mjs:10` requires), where `require("electron")` is the package's path string and `BrowserWindow` is `undefined` — exactly the child's view. The control spawns the same binary with `ELECTRON_RUN_AS_NODE` **removed** from its environment running `control-electron-main.cjs`, which prints `typeof BrowserWindow`, `typeof session.defaultSession` and `typeof ipcMain` after `app.whenReady()` and exits: `"function"`, `"object"`, `"object"` (measured on macOS, 2026-10-08, Electron 44.3.0; the same script under `ELECTRON_RUN_AS_NODE=1` fails at `require("electron")` with `MODULE_NOT_FOUND` — a result for the development executable only; the packaged gate has its own control, A2 Gates). Per platform in CI: macOS and Windows start the helper directly; Linux runs it under `xvfb-run -a`, with `xvfb` added to the apt line of `linux-confinement-tests` (`ci.yml:447`), because Electron needs a display driver and Xvfb is its documented answer for a headless CI host (Electron, "Testing on Headless CI Systems", checked 2026-10-08). A helper that does not start is a failed control and fails the file under `AVE_REQUIRE_SANDBOX_CASES=1`; off CI, on a host with no display and no `xvfb-run`, the file reports the control `not-run` and this row `not exercised` rather than passing it, and no stub stands in for the helper | the validator inherits its executable (`validate-plugin.ts:696-706`) and the fixture's location: under the app's runner from a temporary copy the four results are the wrap's; run from a checkout, the bare `require("electron")` resolves the app's own `node_modules/electron` (the path string); under plain Node `import("electron")` rejects with `ERR_MODULE_NOT_FOUND` — so the CLI row asserts "no usable API in any form" by shape, with the resolution outcome recorded per executable and location rather than asserted |
| 4. A host internal | patch `globalThis.fetch` and `process.stdout.write`, then write to fd 1 directly (bypassing the diverted `process.stdout`, `plugin-child-main.ts:72-84`): one non-JSON line, and one JSON-RPC `ave/host/getSecret` frame for a foreign key carrying extra `pluginId` and `_meta` identity fields | the non-JSON line is dropped by the production decoder and the session continues (decision 40; the next `tools/call` succeeds); the forged frame is dispatched under the identity bound at spawn (§2.4, §7.2 "host-derived identity"), its unknown optional field is ignored and logged (§3.3), and the call answers `null` with the denial audited under the fixture's own id exactly as (1b); the host's own `fetch` and the bound dispatch table are the same objects before and after (identity equality) — the control imports the fixture's `patch()` helper into the test process and observes `globalThis.fetch` replaced | the CLI's stdout tee fails the run on the non-JSON line (decision 40), which is the assertion; the forged frame reaches the validation session as the plugin's own request |

The fixture's tools throw only when an escape **succeeds where the harness claims it
cannot** — under the wrap — and otherwise return `{ attempt, outcome }`; the
`expectConfined` argument (from `--tool-args` under the CLI, from the test under the
wrap) is what switches between reporting and asserting, so one fixture serves both
harnesses without a skip. Tool names follow `^[a-zA-Z_][a-zA-Z0-9_]*$`:
`escape_secrets`, `escape_network`, `escape_electron`, `escape_patch`.

#### Slices

Each slice is independently mergeable, coherent at its own boundary, and implementable
in a separate checkout. **Host slices (A1, A2, O1, O2, R1, and the code half of P7) are
go; plugin-side slices (G0, G1, C1, C2, C3) are planned outside this document
(decision 49).** Order:

```
A1 (routing, census, arm + Doctor)  ─┐
A2 (adversarial fixture)             ├─ 0.14.0 host content; A2 after A1
G0, G1, C1-C3 (plugin side)          │  planned outside this document
O1 (official URL switch) ────────────┤  only after the official repository is public
O2 (E2′ carry-over: re-vendor, mirror)┘  only after Actions run again
R1 (0.14.0 release PR)                   after A1, A2; O1 in it only if its gate is met
P7 (retirement)                          code half after the plugin-side releases; owner half per §9.3's notice rule
```

Dependencies that are **not** there: A1 does not wait for G1 or C-anything (fact 12: a
`git` ≤ 0.2.1 install is refused before activation on either arm, and the protocol-2
`entry` plugins that do change arm are covered by R1's release note, not by a shim), and
0.14.0 does not wait for the plugin-side source — but `git` is never published again before
G1 (decision 54), and `git` 0.2.2 (#27) is superseded by G1, not merged.

##### A1. Routing without an input, and the arm on the record

*Change.* `importPluginFactoryForLifecycle` loses its census and its in-process branch:
after the provenance gate and the kind check, a `process` source returns the process
launch exactly as today (`runtime/index.ts:5271-5283`), and an `entry` source returns
`createOutOfProcessPluginFactory({ ...outOfProcess, launch: { kind: "entry", entryPath:
source.resolvedEntryPath } })` **unconditionally** — the eleven lines at `:5284-5294`
minus their condition. The `try`/`catch` at `:5296-5310`, the `bustCache` parameter and
its four call-site arguments (`:4056`, `:4962`, `:5624`, `:6374`), and the
`importPluginFactory` name in the import at `:66` are deleted. The method's return type
becomes `{ createPlugin: RuntimePluginFactory; arm: PluginLoadArm }` with
`PluginLoadArm = "child" | "in-process"`, and `LoadedPlugin` (`src/plugins/runtime/types.ts:30`;
the map at `index.ts:1735`, the registration at `:5737`) records `arm`. The doc comment at
`:5236-5248` is rewritten: there is no
routing SOT; the sentence "It is a routing decision and NOT a fallback" stays, because
a child that cannot be spawned or confined still fails the load.

*What stays, and why (decision 50).* The in-process factory import moves into one
exported function in `src/plugins/runtime/plugin-loader.ts`,
`importInProcessPluginFactory(resolvedEntryPath)` = `runPluginImportWithTimeout(() =>
importPluginFactory(resolvedEntryPath))` with `PluginImportTimeoutError` (both move
with it from `runtime/index.ts:1174-1215`), keeps its unit tests, and has **no
production caller**: its knip baseline entry names the owner (decision 5) and the
removal condition (§9.3 as restated below). `importPluginFactory` itself is the
child's (`plugin-child-main.ts:230`) and is not deprecated. The `"in-process"` member
of `PluginLoadArm` exists so the Doctor text and the predicate below are honest about
what the tree still contains; Loader removal narrows the union.

*The census goes now.* `OUT_OF_PROCESS_PLUGIN_IDS` and `isOutOfProcessPlugin` are
deleted from `out-of-process-plugins.ts` together with the per-plugin admission
narrative that justified them (`:1-874`, history keeps it); the file keeps one export,
`allPluginsAreOutOfProcess(loaded: ReadonlyArray<{ pluginId: string; arm: PluginLoadArm
}>)`, true when the list is non-empty and every `arm` is `"child"` (decision 51). The
pins move with it: `host-api-boundary-contract.test.ts:306-344` becomes a test that the
predicate is fed from the registry and that no module outside
`src/plugins/runtime/plugin-loader.ts` and `src/plugins/isolation/plugin-child-main.ts`
imports `importPluginFactory` (an import-boundary test in the style of the one decision
30 added for `src/plugins/validate/`); `boot-preflight.test.ts:230-233` takes any
manifest id (every plugin is isolated now); `floating-surface-resolver.test.ts:84`,
`:260` keep asserting that the resolver does not branch on routing, with the routing
names removed; `out-of-process-routing.test.ts` becomes the **routing matrix**, in three
kinds of case over three separate dimensions — the registry's `origin.sourceKind`
(`official`, `managed`, `custom`, `direct`; `registry.ts:297`), the artifact rung
(`release`, `archive`, `tree`, `folder`, `legacy`; `:298`) and `installSource` (`user`,
`local-dev`, and the legacy `admin`/`dev-link` values; `:283-289`), plus an origin-less
legacy entry, on each platform: (i) **positive `entry` routing** — every combination
routes to the out-of-process factory with `arm: "child"`; (ii) **admitted `process`
routing** — a `process` manifest with a verified `git` receipt from a marketplace source
kind, rung `release` or `archive` and a sha256 pin, on macOS or Linux with the sandbox
on, routes to the process launch; (iii) **explicit refusals** — a `process` manifest
from `direct`, from a folder rung, under `local-dev`, or with unverified legacy
provenance is refused by the provenance gate **before any factory exists**
(`src/plugins/process-entry.ts:96-112`, `process-entry-requires-pinned-artifact`), and
an admitted one on Windows or with the sandbox off is refused by the factory
(`out-of-process-plugin.ts:1091`, `ProcessEntryUnconfinedError`). Routing and admission
are different questions; the matrix answers both and never lets a refusal read as a
route. It is the mechanical form of "out of process by default for every install and
every source" (decision 3).

*"True for the official index."* A test under `src/marketplace/__tests__/` reads the
committed `marketplace.json` of the official repository at `6a4d3b3df` as a fixture
(the five packages; `assistant` included, since it is still indexed), parses each
version's released manifest shape and routes it through the matrix: every one is
`"child"`. The fixture is a historical capture of the published index. This is
the §9.1 proof; it does not download anything.

*Doctor, wired end to end.* Decision 3 promised that the plugin Doctor names, per
plugin, the confinement it runs under; nothing does so today. The panel is rendered by
`src/ui/renderer/tabs/PluginConfigTab.tsx:855` when a card's `loadStatus === "failed"`
(`src/ui/renderer/utils/plugin-doctor-view.ts:1-12` only resolves the navigation key);
the card is projected at `runtime/index.ts:7561-7575`, which copies
`installFailureKind`/`installFailureMessage` from `loadFailureInfo` (`:1799-1802`;
written at `:2951`, cleared at `:3442`, `:3897`, `:5538`, `:5554`) and from
`failedPluginStubs`. A failed construction never registers a `LoadedPlugin`, so A1
carries `arm` and `confinement` in three places: (1) `LoadedPlugin`
(`src/plugins/runtime/types.ts:30`) for a plugin that loaded; (2) the `loadFailureInfo`
value for a construction that failed **after** routing — a factory error
(`PluginSandboxGrantError`, `ProcessEntryUnconfinedError`), a spawn or wrap failure —
with `arm: "child"` and the confinement the spawn reported, or `"not-spawned"` when no
child existed; (3) the card projection at `:7561`, read by the Doctor panel for a failed
plugin and by the loaded-plugin row for a running one, with i18n keys in `en.ts` and
`ko.ts`. Two types, because the spawn and the diagnosis answer different questions:
`SpawnConfinement = "macos-sandbox" | "linux-bubblewrap" | "windows-srt" |
"unconfined"` is the **wrap outcome** — the spawn result of `spawnConfinedChild`
(`src/permissions/confined-child.ts:135`) gains a `confinement` field set from the wrap
it actually applied, which `spawnConfinedPluginChild` (`out-of-process-plugin.ts:827`)
passes through — never the global `features.pluginWorkerConfinement` setting, so a child spawned
unwrapped on a host with the setting on is shown as `unconfined`; and
`PluginConfinementReport = SpawnConfinement | "not-spawned"` is what `LoadedPlugin`,
`loadFailureInfo` and the card carry — five values, the fifth only for a construction
that failed before any child existed, and the Doctor text has a key for each. No new
IPC channel and no new error code: the card DTO grows by two optional fields.

*The resolver's guidance (G1's `~` case, host-generic).* `rejectEnvelopeGrant`
(`out-of-process-plugin.ts:194-199`) prefixes every refusal with the plugin id and the
config key, but the non-absolute branch (`:408-427`) names no corrective action. A1
appends one generic sentence to that refusal — "enter an approved absolute directory for
'<configKey>', or clear the setting" — stored as `installFailureMessage` and shown in the
Doctor panel; no plugin-specific branch. A recovery test in
`out-of-process-plugin.test.ts` proves the three states from a stored `~/…` value:
construction fails with that message and no child; an approved absolute path plus a
restart loads; clearing the value loads with no grant (`:399-403`).

*What a user sees on upgrade (decision 52).* A plugin that conforms sees nothing: the
same members, the same manifest. **Every protocol-2 `entry` plugin outside the census
changes arm on 0.14.0** — third-party, folder and direct installs included (fact 12) —
and the host adds no shim for it. A plugin whose child cannot be spawned or wrapped fails
to load with the factory's existing error, shown in plugin status with the Doctor's
`arm`/`confinement`, and is **not** retried in process — the same outcome the five
isolated plugins have had since the wire step. A plugin that used an ambient capability
fails at that call (a direct `fetch` refused by the OS with the sandbox on, or silently
reaching the network with it off, which admission never promised to prevent — decision
3); the fix is the plugin's next version, and the update path is the one the status
already shows. A plugin that declares no served `hostProtocol` and reaches the routing
function through prepared activation or restart (fact 12) is refused by the child
factory's check before its child connects (`connectionHostProtocol`,
`out-of-process-plugin.ts:1057`, called at `:1085`), the same refusal boot and add make
explicitly. A1 wires the two **invocation** catches (`runtime/index.ts:5141`, `:6443` —
not the lookup catches, which never see the factory's error; the rejection arrives
unwrapped, `:1232`, `:2219`, so the existing `instanceof` classification works) to
report the refusal **without** `markLoadRefused` (`:2972-2988`, which marks the plugin
failed while a running generation still serves) and without touching the incumbent.
Both catches emit the boot/add audit event (`plugin_incompatible_host_protocol` with the
declared and served versions, `:3052-3056`) and record the attempt in one new
in-memory map beside `loadFailureInfo` — `lastAttemptRefusal: Map<pluginId, { attempt:
"update" | "restart"; kind: PluginInstallFailureKind; message: string; at: string }>` —
cleared where `loadFailureInfo` is cleared (`:3442`, `:3897`, `:5538`, `:5554`) and when
a later attempt commits (`replaceRuntime`, `:6529`; the prepared commit). The sibling
refusals (`ProcessEntryUnconfinedError`, `PluginSandboxGrantError`, `:5693-5696`) take
the same route. What the user sees differs per path, and each transport is existing
code:

*Prepared activation (an update).* The error propagates (`:5165`) to
`src/plugins/marketplace.ts:956`, the install flow's one call of the runtime's
activation, which A1 makes translate `IncompatibleHostProtocolError`
(`host-api-wire.ts:87`) into the **existing** `MarketplaceError("PACKAGE_INCOMPATIBLE",
<the same message>, { detail: { reason: "host_protocol", name } })` (the options
object of `errors.ts:386-390`) — the code exists
(`src/marketplace/errors.ts:39`), its `host_protocol` detail exists (`:304`; the catalog
already produces it for an unserved version, `service.ts:1648`, `aggregate.ts:87`), and
`MarketplaceError` is already imported there (`marketplace.ts:42`). The apply queue's
`failureRecord` (`background.ts:148-151`) then stores `{ code: "PACKAGE_INCOMPATIBLE",
detail, message, at }` as the update's `lastError` in `~/.ave/marketplaces/updates.json`
(`history.ts:54-59`: `version: 1`, an exact key list at `:146`, and **no key is added**,
so nothing changes for an older or newer reader), `failureView` (`:137-139`) projects it
into `PackageUpdateView.failure` (`src/shared/git-marketplace.ts:560`), and
`UpdatesCard.tsx:609-620` shows the update as failed with its attempts and, behind
*details*, the existing "incompatible host protocol" label (`labels.ts:612-618`,
`gitMarketplace.error.incompatible.hostProtocol`) and the message. Today the same error
arrives as `code: "unavailable"` (`:152`), which reads as the source being unreachable;
the translation is what makes that surface truthful. No new error code, no new IPC
channel, no persisted-shape change.

*Restart.* `restartPlugin` keeps returning `"failed"` (`RestartPluginResult`, `:1680`;
its callers compare the string and stay as they are: `src/ipc/domains/plugins.ts:771`,
`:854`, `src/boot/steps/alerts-setup.ts:60`, `marketplace-setup.ts:101`,
`plugin-runtime/host-api-factory.ts:705`, `refresh-active-llm-wildcard.ts:120`). The
user-initiated restarts are the config and secret saves (`src/ipc/domains/plugins.ts:767-776`,
`:850-859`), which already answer a `"failed"` result with the existing
`plugin-config-save-failed` / `plugin-config-secret-save-failed` reply whose message is
built from the result string; A1 makes that message carry the recorded refusal
("runtime reload refused: <message>"), read from the plugin's card (`listPluginCards`,
`:7521`, the cards channel's own producer, `src/ipc/handlers/plugins.ts:189`) — no new
channel, no new error code. Background restarts (`alerts-setup.ts:59-61`,
`marketplace-setup.ts:100-102`, `refresh-active-llm-wildcard.ts:120-122`; the plugin's
own `config.set` reload, `host-api-factory.ts:701-713`, which returns the message to the
plugin) keep their logs; for them the audit event is the record and the card field
below is what a user can see.

*The card.* `PluginCard` (`runtime/index.ts:106`; produced by `listPluginCards`,
`:7521`, the projection at `:7561-7575`) gains one optional field, `lastAttemptRefusal`,
copied from the map for a plugin whose `loadStatus` is `"loaded"` — the failed-only
copy at `:7564-7568` is unchanged — and the renderer's `PluginCardSummary`
(`src/ui/renderer/types.ts:148`) gains the same optional field; the loaded-plugin row
(`PluginConfigTab.tsx:699`) shows one muted line, "last update refused: <message>" or
"last restart refused: <message>" (i18n keys in `en.ts` and `ko.ts`), and keeps its
loaded state. **What the Doctor shows for a running plugin whose update was refused:
nothing failed** — the Doctor panel renders only for `loadStatus === "failed"`
(`PluginConfigTab.tsx:855`) and the protocol update-path lookup only for a failed card
(`:449`), so the plugin reads as loaded at its running version with that one line, and
the Updates card carries the failed update. Consumers of the widened card:
`listPluginCards` and its two callers (`src/ipc/handlers/plugins.ts:189`,
`src/ipc/domains/tour.ts:88`), `PluginCardSummary` and `PluginConfigTab.tsx`; the field
is not persisted. Lock suites — `channel-inventory`, `preload-shape`,
`format-ipc-error-coverage`, `domain-exports`, `settings-section-anchors` and
`settings-store` — are **unchanged**: no channel, no preload method, no error code, no
export and no setting is added.

A1 tests both paths with such a manifest for **both** properties. Prepared activation:
`activatePreparedArtifact` rejects with `IncompatibleHostProtocolError`; the audit
callback receives the same event and fields as boot and add; the install flow surfaces
`PACKAGE_INCOMPATIBLE` with `reason: "host_protocol"` and the same message (a test on
the activation step of `src/plugins/marketplace.ts`, and the apply-queue test asserting
the stored `lastError`); the card shows `lastAttemptRefusal` with `loadStatus:
"loaded"`; `generationLifecycle.getActive` returns the same generation id (`:5148`), the
incumbent's tools still answer and the retained generation is removed (`:5159-5163`) —
the shape `capability-active-generation.test.ts:1195` already uses. Restart:
`restartPlugin` resolves `"failed"` and the incumbent's tool still answers (as
`:1124-1125` already asserts); the audit event; the card field; the unpublished runtime
root removed (`:6453`); and the config-save reply carrying the message (a handler test
beside `src/ipc/domains/__tests__/plugins-set-enabled.test.ts`). No manifest field,
setting or environment variable selects the arm.

*Files.* `src/plugins/runtime/index.ts` (`:66-69`, `:106`, `:1174-1215`, `:1735`,
`:1799-1802`, `:2951`, `:3047-3065`, `:3602`, `:4056`, `:4962`, `:5141-5165`,
`:5236-5310`, `:5624`, `:5737`, `:6374-6380`, `:6443-6457`, `:6529`, `:7521`,
`:7561-7575`); `src/plugins/runtime/types.ts:30` (`LoadedPlugin`,
`PluginConfinementReport`); `src/plugins/runtime/plugin-loader.ts`;
`src/plugins/isolation/out-of-process-plugins.ts`;
`src/plugins/isolation/out-of-process-plugin.ts` (`:194-199`, `:408-427`, `:827` passing
the spawn result's `confinement` through); `src/permissions/confined-child.ts:135`
(`SpawnConfinement`, the wrap outcome); `src/plugins/marketplace.ts:956` (the
`PACKAGE_INCOMPATIBLE` translation; `MarketplaceError` imported at `:42`);
`src/ipc/domains/plugins.ts:767-776`, `:850-859` (the reply message);
`src/ui/renderer/types.ts:148` (`PluginCardSummary`);
`src/ui/renderer/tabs/PluginConfigTab.tsx:699` (the loaded row's line) and `:855` (the
Doctor panel), with the card DTO they read; `src/i18n/messages/{en,ko}.ts`; `knip`
baseline. Cited and unchanged: `src/marketplace/app/background.ts:137-153`,
`src/marketplace/updates/history.ts:54-59`, `:146`, `src/marketplace/errors.ts:39`,
`:304`, `src/ui/renderer/tabs/git-marketplace/UpdatesCard.tsx:609-620`, `labels.ts:612-618`.

*Tests.* The four test files named above, rewritten as described, with the routing
matrix in its three kinds; `PluginConfigTab` tests for the two card fields in the loaded
and the failed state; prepared-activation and restart cases with an undeclared
`hostProtocol`, refused by the factory's check at invocation — asserting the audit
event, the surface named in "What a user sees on upgrade" (the `PACKAGE_INCOMPATIBLE` /
`host_protocol` update failure; the config-save reply and the card's
`lastAttemptRefusal`) with the same message as boot and add, the unchanged incumbent
generation id and its still-answering tools; the `~` recovery test. Two suites that
today share one heap with the plugin they load migrate with A1, because the plugin code
now runs in a child: `capability-active-generation.test.ts` parks deferred gates on the
host's `globalThis` and reads them from dynamically imported plugin code (`:505-513`,
`:770-775`; nine `__aveCapability*` sites) — its gates become either host-side
lifecycle seams on the runtime subclass, where the ordering under test is the host's, or
a cross-process gate under the test's `AVE_HOME` (a file the host creates and the
fixture polls, where the plugin must block), never a global the child cannot see; and
`startup-timeout.test.ts:1-4` imports `runPluginImportWithTimeout` from
`runtime/index.ts` and follows the helper to `plugin-loader.ts`. Removing the
unconditional `entry` route must fail the matrix; removing the import-boundary test's
subject must fail it (each test is proven live by the ablation the suite already uses
for routing).

*Gates.* `bun run typecheck`; `bun run test:vitest -- run src/plugins src/marketplace
src/ui/renderer/__tests__`; `bun run build`; `check:i18n-catalog` (the two keys must
exist in both catalogs — a parity check alone does not catch a missing key);
`check:knip:engine` against the updated baseline; naming gate; CI rollup including the
macOS and Linux confinement jobs and the Windows job (an `entry` child on Windows is the
common case from now on). **Native verification points:** macOS arm64, Windows x64 and
Linux arm64 each boot a packaged build with `hello-world`, `templates/extension` and a
third-party `entry` plugin installed from a folder source, and the Doctor shows
`arm: child` for each with the platform's confinement; with
`features.pluginWorkerConfinement` off and on.

*Lock suites.* `channel-inventory`, `host-renderer-only-channels`, `preload-shape`,
`format-ipc-error-coverage`, `domain-exports` **unchanged** (no channel, no error
code); `settings-section-anchors`, `settings-store`, `packaging-discipline-source`,
`bootstrap-integration`, `use-send-message-resource`, `alert-predecessor` unchanged
and run the affected suites while iterating; `test/scripts/*` unchanged.
The pre-push hook's fixed lock selections are defined in
`scripts/hooks/pre-push-source-policy.mjs`.

##### A2. The adversarial fixture

*Where it lives.* `src/plugins/isolation/__tests__/fixtures/adversarial/` — `plugin.json`
(protocol `3`, `minAppVersion: "0.14.0"`, `networkAccess.allowedDomains: ["example.com"]`,
`sandbox.write: [{ kind: "userChosenDirectory", configKey: "escapeDir", why: "the
escape test's probe directory" }]`, `configSchema.properties.escapeDir` string, four tools),
`entry.mjs` (the four tools and the `patch()` helper the control imports),
`vendored-electron/index.js` (the planted package entry — `module.exports` a path
string — which `escape_electron` loads through its explicit path; the fixture has no
`node_modules`, so the bare specifier stays unresolvable, as
`confined-plugin-child.test.ts:418` arranges), `control-electron-main.cjs` (the positive
control's main-process script, table row 3) and `tool-args.json` (`expectConfined:
false` for the CLI). A fixture directory may carry the name; no production file does
(naming gate).

*Built against the validate CLI first.* `src/plugins/validate/__tests__/adversarial-fixture.test.ts`
runs `validatePlugin` over the fixture with `tool-args.json` and asserts: every standard
row passes (the fixture is a well-formed protocol-2 plugin), `escape_electron` reports no
usable main-process API in any of its forms (the resolution outcome recorded per
executable and location, table row 3), the `sandbox.grants` row is `not exercised`, the validation host's
transcript records the foreign-key `getSecret` and the undeclared `hostFetch` URL (the
probes are live), and a second run whose tool call asks `escape_patch` to emit the
non-JSON line fails the run with the stdout-discipline row (decision 40). `bun run
plugin:validate src/plugins/isolation/__tests__/fixtures/adversarial --tool-args …` is the
command an author can run.

*Then the real wrap.* `src/plugins/isolation/__tests__/adversarial-escapes.test.ts`,
gated like `confined-plugin-child.test.ts:236-240` (the gate helper moves to a shared
test helper so both files use one), spawns the fixture through the **production**
factory with `observeChild` for the raw stdout, under an isolated `AVE_HOME` (as #2612
made the rule) holding a sentinel `secrets/` file and a second plugin's data directory,
with the **production** secret gate, audit sink and `hostFetch` guard behind the host
API (a recording double cannot prove a denial), and asserts the table above with
`expectConfined: true`: each tool's result, the `null` and the audit line for (1b) with
the own-namespace control, the listener's record, the spawn refusal for (1c), the
identity of the host's `fetch` and table, and the session surviving (4). The control
cases run first in the same file: the sentinel is readable from the test process, the
listener accepts a connection from it, the full main-process helper
(`control-electron-main.cjs`: the same binary with `ELECTRON_RUN_AS_NODE` removed from
its environment) reports `BrowserWindow` as a function — the test process cannot be that
control, because it runs under `ELECTRON_RUN_AS_NODE=1` itself
(`run-vitest-under-electron.mjs:154`; `assert-electron-node-vitest.mjs:10`) and sees the
same path-string export the child sees — and `patch()` changes `globalThis.fetch` in the
test process (and is restored in `finally`). A control that fails, or cannot start,
makes the escape assertions meaningless, so it fails the file; on Linux the helper runs
under `xvfb-run -a` and the job installs `xvfb` beside bubblewrap (`ci.yml:447`; table
row 3). The fixture is staged under a temporary plugin root outside the checkout, as
`confined-plugin-child.test.ts:304-308` does, so a bare `require("electron")` cannot
walk up into the app's `node_modules`. Windows has no CI step for this file: the
hosted runner does not provision srt-win, so with the flag set the file could only fail,
and on this branch the `entry` child does not yet start under srt-win (below). Windows
is measured on a provisioned host instead, and is not a gate for inter-plugin claims
there (decision 64).

*The `process` variant.* Escapes 1 and 2 are added to the Python smoke
(`python-smoke-harness.ts`, P5) as two more tool calls under the same wrap, because the
substrate is the same `spawnConfinedChild` and a non-JS child is where a reviewer would
expect the filesystem claim to be re-proven; 3 and 4 are JS-specific and are not
duplicated.

*Gates.* As A1, plus `AVE_REQUIRE_SANDBOX_CASES=1` on the three confinement jobs for
the new file (a run that returns green without measuring is a failure here, not a skip).
**Native verification points:** (i) under vitest, the file passes on macOS arm64
(sandbox-exec), Linux arm64 and x64 under bubblewrap, and Windows x64 under srt-win;
(ii) **the packaged gate**, on the same three platforms from a packaged build: the escape
probes run from the packaged runtime's Node — the packaged executable with
`ELECTRON_RUN_AS_NODE=1`, which is exactly what the production factory spawns
(`out-of-process-plugin.ts:678-690`) — as a script from a temporary root, and report the
same four shapes as row 3; and **the packaged control is the packaged application's own
main process**: launched through Playwright, `electron.launch({ executablePath, … })`,
the driver the repository already uses for an installed build. The A2 gate owns its own
copy of the launcher's environment: `packagedEscapeGateEnvironment()`
(`scripts/lib/packaged-escape-gate-environment.mjs`), an allow-list that leaves
`ELECTRON_RUN_AS_NODE` out, carries no `AVE_A2A_EVIDENCE_*` key, imports nothing from
another harness, and establishes no profile of its own; `packaging-discipline-source.test.ts`
pins the list. So the A2 launch adds the profile isolation and platform flags the other launchers apply
(`--user-data-dir` and a temporary `AVE_HOME`, `test/e2e/ui/seeded-electron.ts:245-259`;
the Windows no-sandbox environment and the deleted `ELECTRON_RUN_AS_NODE`,
`scripts/lib/electron-launch-options.mjs:77-87`), and asked in the main process —
`app.evaluate`, the form `seeded-electron.ts:318` already uses — for `typeof
BrowserWindow`, `typeof session.defaultSession` and `typeof ipcMain`: `"function"`,
`"object"`, `"object"`. Removing `ELECTRON_RUN_AS_NODE` from the packaged executable
starts the packaged application (`package.json:36`, `main` inside `app.asar`,
`scripts/smoke-packaged-app.mjs:242-246`), never `control-electron-main.cjs`, so **a
development-helper result is never packaged evidence**: row 3's helper measures the
development executable, the packaged control is this evaluation, and each is recorded
per platform. The attach needs the packaged binary to accept Playwright's inspector
flags, which it does: no Electron fuse is flipped in the build — `flipFuses`,
`FuseV1Options`, `FuseVersion`, `electronFuses`, `@electron/fuses` and `fuses` searched
across `package.json` (the `build` block at `:228`; `afterPack` at `:235` is
`scripts/electron-after-pack.cjs`, which prunes binaries and names no fuse), `scripts/`,
`.github/` and `bun.lock` at `c4c9689d2` hit only the transitive lockfile entries
(`bun.lock:240`, `:1072`, `:2676`, `:2808`: `app-builder-lib`'s own dependency), no
configuration and no invocation — and the live driver already attaches to an installed
build.
Measured so far: the development helper on macOS (2026-10-08); the packaged values on
macOS arm64 (2026-10-09, `scripts/packaged-escape-gate.mjs` against an unpacked
`--dir --fast` build, ad-hoc signed and launched with Chromium's `--use-mock-keychain`,
which the gate passes on macOS because a first `safeStorage` call under an identity the
login keychain has not seen holds the main process on an access prompt): control
`function`/`object`/`object`, probes `44.3.0`, `MODULE_NOT_FOUND`, an inert namespace,
a path string, no usable form; and under vitest on Linux arm64 (2026-10-09, bubblewrap
0.12.0 in a `node:24-trixie` container), the wrap suite 11/11 with the Electron control
under `xvfb-run -a`. The Windows helper, and the Linux and Windows packaged values, are
UNVERIFIED until the first run, and a control that cannot be launched fails the gate
rather than passing it. The gate runs after the packaged smoke in `build-installers.yml`,
under the same condition, so an unsigned macOS candidate skips both.

*As implemented (2026-10-09).* What the text above did not say, each found by the
fixture or by the independent verification of it rather than decided around it:

- **Another plugin's data directory was readable.** Plugins are installed under
  `<AVE_HOME>/plugins` (`plugin-paths.ts`), which the shared read floor does not cover,
  and ASRT's reads are deny-only — so on macOS a confined child listed and read a
  neighbour's `data/` (escape 1a, first run). Every wrap of plugin-owned or third-party
  code now refuses the whole plugins root, through one flag the shared layer applies,
  `PerCommandFilesystem.denyPluginsRoot` (`asrt-sandbox.ts`): the plugin child, its
  delegated workers (`worker-spawn.ts`), bundled hooks and MCP stdio servers
  (`wrap-bundled-command.ts`). Each re-allows only its own directories inside the deny —
  the child its envelope, a worker the grants the dispatcher held to that envelope, a
  hook its generation and data, a bundled server its generation payload
  (`McpStdioServerConfig.bundledPayloadRoot`, set by `preparePluginMcpGeneration`
  and dropped from any other source at connect); a server of no plugin re-allows
  nothing there. On macOS the root is spelled exactly, as the private roots are, so a
  wrap reading the host temp directory above a test `AVE_HOME` keeps its own. The deny
  is the root, so a plugin installed after a spawn is covered (row 1a asserts it). The
  verification also found the two detours the first fix left: a worker the child asked
  for printed the neighbour's data (now row 1a by delegation), and a hook could copy it
  into the data directory the child reads.
- **An agent plugin's directories sat outside that root, and were readable too.** An
  agent plugin keeps its data under `<AVE_HOME>/agent-plugin-data/<name>` (the
  feature namespace `agent-plugin-hook-runtime.ts` and `agent-plugin-mcp-runtime.ts`
  open) and its installed versions under `<AVE_HOME>/packages/agent-plugin/<name>/<version>`
  (the content store's `<kind>/<name>/<version>` layout, `content/store.ts`); the floor
  covers neither, so an `entry` child, its workers and every bundled hook or server
  could read them. The same flag now refuses both roots beside the plugins root
  (`ensurePluginOwnedReadRoots`, `asrt-sandbox.ts`), each created before the wrap
  because bubblewrap skips a deny on a path that is not there. No `entry` plugin owns
  anything under them; an agent plugin's own hook or stdio server re-allows its own
  version and data — the hook through its generation root and data directory, the
  server through `bundledPayloadRoot`, which `resolveRuntimeMcp` (`agent-plugin-mcp.ts`)
  now sets to the version it runs from. Measured under the real wrap on macOS (seatbelt)
  and on Linux (bubblewrap 0.12.0, `node:24-trixie`, arm64), with a neighbour sentinel in
  each root and failing before the change on both: the plugin child and its
  delegated worker (row 1a, `adversarial-escapes.test.ts`), a child, an entry plugin's
  hook and an agent plugin's hook or server (`asrt-protected-write-roots.test.ts`), and
  the hook runner end to end with its generation under each root
  (`bundled-hook-asrt.smoke.test.ts`, which also turns red when the deny or the own-read
  re-allow is removed from `wrap-bundled-command.ts`).
- **On Linux a read re-allow could take a plugin's data directory away.** ASRT masks
  the denied root with a tmpfs and binds the write roots back before the read
  re-allows, so a plugin whose root holds its data directory got the root's read-only
  bind over the data's writable one (EROFS). `hardenLinuxSandboxWrap` now binds every
  mount the re-allow covered again right after it, except a write under one of the
  wrap's write denies (`linux-sandbox-wrap.ts`, `replayShadowedMounts`); the row-1a
  control writes and reads back the child's own data inside the sandbox.
- **On Windows plugins are not isolated from each other, by owner decision
  (2026-10-10).** All plugins, third-party ones included, run there in the one shared
  `srt-sandbox` identity: sandboxed from the host as configured, not from each other.
  This is an accepted risk pending an ASRT per-plugin identity; no install gate,
  warning, serialization or source restriction stands in for it. The facts it rests on,
  for the ASRT 0.0.80 we ship (its README, `windows-sandbox-utils.js`, and the srt-win
  source): every sandboxed process runs as that one account,
  started through `CreateProcessWithLogonW` and a `CreateRestrictedToken` token without
  restricting SIDs; an allow is a session-level ACL grant to that account's SID; a
  per-execution deny is a holder-refcounted ACE on the same SID. So a deny on plugin A's
  neighbour also takes their own directories from a concurrently running plugin B's
  processes, and anything granted to A's processes is readable by B's while it is held —
  which is why `denyPluginsRoot` is refused on Windows (`asrt-sandbox.ts`) and nothing
  replaces it. Upstream `@anthropic-ai/sandbox-runtime` releases through 0.0.80 (checked
  2026-10-19) still offer no per-execution identity, and per-execution `allowRead` /
  `allowWrite` remain unsupported on Windows.

  What the code grants a Windows plugin child: its own envelope (root, data, socket and
  worker-run directories) and its throwaway HOME, read and execute, with write where the
  envelope writes, as the same holder-PID ACL grant a delegated worker holds
  (`holdWindowsFilesystemGrant`, `windows-acl-grant-holder.ts`; `spawnConfinedPluginChild`,
  `out-of-process-plugin.ts`). The wrap stays deny-only and the session config still grants
  nothing. The grant is taken before the spawn, against a System32 holder process the host
  owns, and released on every way the child ends (exit, close, a spawn with no process, a
  failure before or during the spawn); a holder that dies stops the child. Because Windows
  has no `denyPluginsRoot`, the grant itself is held to the plugin's own roots
  (`pluginGrantPathsBeyondOwnRoots`, `asrt-sandbox.ts`): inside the plugins root only under
  `<plugins>/<id>` or `<plugins>/.cache/<id>`, nothing inside the agent-plugin roots, and
  nothing at or above any of them; anything else refuses the load. It isolates nothing
  between plugins (decision 64): while the grant is held every confined process reaches
  those directories.

  **Measured on a provisioned Windows 11 host (2026-10-10, ASRT 0.0.76 `srt-win install`;
  `<AVE_HOME>` under a directory inheriting the default profile ACL).** The ACL variable
  was measured in isolation: an Electron-as-Node probe run through `srt-win exec` with the
  production deny floor, reading and writing as `srt-sandbox`.
  - No grant (the code before this change): its own data read and write, a neighbour's
    data, and the secrets sentinel all `EPERM`.
  - Its own grant held: own data read and written; neighbour data read and write `EPERM`;
    secrets `EPERM`. The grant's `(OI)(CI)` ACEs sit on its own directories only — none
    on the plugins root or the neighbour — and are gone after release, after which every
    read is `EPERM` again.
  - Two grants held at once (the concurrent case, not fixed by owner decision): the
    first plugin's probe read the second plugin's data and wrote into it; after the second
    grant was released the same probe got `EPERM` again.

  **The `entry` child under srt-win.** Before the loopback channel (§2.3) the child itself
  did not start under srt-win, grant or no grant, and escapes 1a/1b, 2 and 4 failed on
  Windows with "child exited code=0"; that failure was not the ACL. Four causes, each
  measured on the same host, and what the spawn does about each
  (`out-of-process-plugin.ts` `windowsLoopbackLaunchLine`, `confined-child.ts`
  `windowsShell: "cmd"`):
  1. *The child's environment was not delivered.* srt-win's runner starts the target with
     the `srt-sandbox` profile environment plus only its `--env` overlay (PATH, PATHEXT,
     proxy). `ELECTRON_RUN_AS_NODE` is now set on the command line; the rest of the
     intended environment (the throwaway HOME, its TEMP) travels as one base64url argument
     the runtime applies before the plugin is imported. What srt-win sets itself stays
     srt-win's (`confined-child.ts` `srtWinTargetEnv`: PATH, PATHEXT, its proxy and CA
     overlay, `GIT_CONFIG_*`, `USERNAME`; TMPDIR is dropped). A Windows worker lost its
     environment the same way (measured, below) and now gets it through the relay.
  2. *PowerShell did not wait for `electron.exe`.* A GUI-subsystem binary returns at once
     under `powershell -Command "& …"`, with no output. The child now runs under System32
     `cmd.exe /d /v:off /s /c`; every token is double-quoted, and a token or value with a
     `"`, a `%`, CR, LF or NUL, or a line over 8000 characters, is refused rather than
     escaped — `cmd.exe` expands `%NAME%` inside quotes, and nothing ends a quote safely.
     What can reach that check is only the host's own: `process.execPath`, the child
     entry's path, Node's flags, the transport argument and the base64url environment.
     Everything a plugin, a user or a profile path contributes — AVE_HOME under a
     profile whose name has a `%`, a hook's or a server's arguments, environment values —
     is inside the base64url argument or a relay request, never on the line. So the
     refusal can be met only through the install directory. `"` cannot occur in a
     Windows path at all. `%` can, but the installer is `oneClick` and `perMachine`
     (`package.json` `build.nsis`): it offers no directory choice and installs under the
     Program Files folder, whose name an installed app does not choose; a `%` there
     would take a relocated Program Files folder. A development checkout under a `%`
     directory meets the refusal, which names the token and says to move the app.
  3. *stdin is not relayed.* The protocol moved to the loopback channel (§2.3).
  4. *The entry module could not be imported from under the profile.* Node `realpath`s a
     module path in JavaScript, which `lstat`s every ancestor directory, and the profile
     admits no `srt-sandbox` access to its subdirectories (measured `EPERM: lstat`). The
     child now runs with `--preserve-symlinks` and `--preserve-symlinks-main`, measured to
     import both an ES module and a CommonJS module from the plugin's own granted
     directory, with and without a `package.json` beside it. What the flags give up is
     resolving symlinks inside the plugin: the entry path is already the host's real path
     (decision 33) and the host's integrity and path checks run on the host's side, so
     those are unchanged; a symlinked file loads under its link's path, and dependencies
     reached through links (pnpm's layout) resolve from the link's location. That trade is
     made on this launch only.

  Measured after the change (same host, 2026-10-10): `adversarial-escapes.test.ts` under
  the real wrap passes every row that runs on Windows (9 passed; the delegation row and
  the Python row are macOS and Linux only). Row 4's fixture now forges on the channel it
  finds among its own handles — fd 1 for a stdio child, the loopback socket here — and
  the host still answers the forged frame under the spawn-bound id. An entry plugin
  loaded through the production factory in about 0.3 s, answered a tool call, wrote and
  read its own data, wrote to its own TEMP under the throwaway HOME, and got `EPERM` on a
  neighbour's data (read and write) and on the secrets sentinel; it was stopped and
  loaded again, and after each stop no `srt-sandbox` process, no holder and no socket
  remained. While it ran its only socket was the established connection: the listener
  was already closed.

  **Workers, bundled hooks and MCP stdio servers under srt-win: the stdio relay.** The
  same host measured what srt-win gives a target it did not write (2026-10-10, a Node
  probe as the target): stdin at end-of-file within 2–3 ms under both inner shells, a
  variable set on the spawn environment absent, `USERPROFILE`/`TEMP` the `srt-sandbox`
  profile's, stderr relayed, and the exit code relayed by `cmd.exe` (7) but not by
  PowerShell (a target exiting 7 reported 1). Through `spawnWorker` the worker read its
  liveness stdin as closed at once and ran without its environment. Bundled hooks and MCP
  stdio servers were refused outright under the Windows sandbox. All three now run
  through the relay (§2.3), each under a holder-PID ACL grant for its lifetime (a hook:
  READ on its generation root, WRITE on its data root; an MCP stdio server: WRITE on its
  sandbox root and its plugin's data root, READ on its bundled payload; both: the
  throwaway HOME, and `<AVE_HOME>/runtime` READ only when the program lives there, as the
  uv Ave materializes for an `uvx` server does). `denyPluginsRoot` and `pinWriteRoots`
  have no srt-win counterpart, so hooks and servers share the one identity like every
  other Windows sandboxed process (decision 64). A server's configured `cwd` is not
  granted: one the account cannot reach fails to start, with the reason on stderr.

  Measured after the change (same host, AVE_HOME under the user profile, programs in the
  plugin's own directories, arguments `100%`, `say "hi"`, `%PATH%`, an environment value
  `%TEMP% "q" & ^`):
  - *Worker* (`spawnWorker`): arguments and the environment value arrived verbatim; HOME,
    USERPROFILE and TEMP were the throwaway HOME's; `USERNAME` was `srt-sandbox`; stdin
    was still open after 3 s; its own data written and read back, its TEMP written; a
    neighbour's data and the secrets sentinel `EPERM` for read and write; an outbound
    connect to `1.1.1.1:443` `EACCES`; exit code 7 reached `onExit`.
  - *Bundled hook* (`runOneHookScript`, real wrap): the payload arrived on stdin,
    `PLUGIN_ROOT`/`PLUGIN_DATA` were set, the same reach as the worker, verdict `allow`,
    exit 0, about 0.5 s. A hook that never exits was denied as timed out at 3 s and no
    `srt-sandbox` process remained.
  - *MCP stdio server* (`McpClient.connect` + `callTool`, real wrap): the handshake and a
    tool call round-tripped in about 0.4 s, the configured environment arrived, the same
    reach as the worker.
  - *Channel loss*: a relayed program reading stdin got its end when the host's socket was
    destroyed mid-run, and the relay exited with the program's code (5).
  - After every run: no `srt-sandbox` process, no holder, no `srt-sandbox` ACE on either
    plugin's directories.
  - Without `--preserve-symlinks` in `NODE_OPTIONS` a Node program under the profile does
    not load (`EPERM: lstat` on the profile directory above AVE_HOME, CommonJS and ES
    module alike); with it both load. A per-user interpreter (Python under
    `%LOCALAPPDATA%`) does not start at all: the account cannot open it, and no grant is
    added for a program outside the plugin's own and the host's runtime directories.

  Not measured: an `uvx` server end to end, which needs registry egress on the allow-list.

  **The loopback channel's authentication (§2.3, §2.4), same host, 2026-10-10.** First,
  what a peer other than the host can do there:
  - *A second listener on the child's port.* With a sandboxed Node listener holding
    `127.0.0.1:P`, a second bind of `P` with `SO_REUSEADDR` failed with `WSAEACCES`
    (10013) both from another `srt-sandbox` process and from the host's account, and
    every host connect reached the first listener. Node exposes no
    `SO_EXCLUSIVEADDRUSE` option; the child relies on this measured refusal.
  - *A sandboxed process dialling another's listener.* `EACCES`: srt-win's network filter
    refuses the sandbox account's loopback connects too, so one plugin cannot reach
    another's channel at all.
  - *A batch file through the relay*, before the refusal: `npx.cmd` by name or full path,
    and a plugin's own `.cmd` or `.BAT`, ended the relay with `spawn EINVAL` (exit 1);
    bare `npx` ended it with `spawn npx ENOENT` (127); bare `node` ran.

  Measured after the change (mutual handshake, batch files refused):
  - *A local process first*: three peers connected to a real relay's port before the host,
    sending the bare nonce, a wrong proof, and 200 bytes without a newline; each was closed
    and answered nothing, and the host connected after them and ran its program (exit 9).
  - *Another loopback address* (re-review): a client bound to `127.0.0.2` connected to the
    child's `127.0.0.1` listener, and against the ports-only handshake the proof for the
    host's port number sent from there was accepted (the case timed out waiting for the
    drop, on Windows and on Linux). With the addresses in the proofs and the address
    check, that peer, and one with a proof correct for its own address, is dropped
    unanswered and the host gets in after it.
  - *The host's second connect*: with four silent peers holding the handshake slots, the
    host's first connect was dropped (`ECONNRESET`, the load failed) before; it now gets
    in on its second connect 0.5 s later, once the slots' handshake time ran out.
  - *Batch files*: `npx.cmd`, `C:\Program Files\nodejs\npx.cmd`, bare `npx` (found as
    `npx.cmd` on `PATH`) and the plugin's own `.cmd`/`.BAT` were refused by `spawnWorker`
    before anything was wrapped, with the reason naming the file; bare `node` ran.
  - *The entry plugin, the worker, the hook, the MCP server and channel loss* gave the
    results above again (load about 0.35–0.42 s; reach, environment, stdin and exit codes
    unchanged), and after each run no `srt-sandbox` process, no holder and no ACE remained.
  - The Windows unit suites of the change (`confined-child`, `child-loopback-link`,
    `worker-spawn`, `bundled-hook-runner`, `mcp-stdio-sandbox-wrap`,
    `windows-bundled-process`, `out-of-process-plugin`, `adversarial-escapes` under the
    real wrap, `safe-env`) passed: 229, 6 skipped (the macOS- and Linux-only rows).

- **The fixture declares `capabilities: ["external-auth-consumer"]`.** Without it
  `hostFetch` is refused by the capability check before the allow-list is reached, and
  row 2 would prove the wrong layer. Row 2 asserts the allow-list's own audit detail:
  `.invalid` never resolves, so the SSRF guard behind it would refuse as well.
- **The planted package carries `vendored-electron/package.json`** (`"type":
  "commonjs"`, `"main": "index.js"`), because the checkout's own `package.json` is
  `"type": "module"` and would make `index.js` an ES module under the CLI harness. The
  row-3 control runs the fixture's own `probeElectron()` in a full main process and
  requires it to report `usable-api`.
- **What the child sees of a refusal is the boundary's, not the host's.** A refused
  `hostFetch` reaches the child as `Host request failed.`, so the reason is asserted on
  the host's audit row (`host_fetch_denied`), and the transport records no call. A
  `getSecret` member read twice is two wrappers, so row 4's identity check is the host's
  `fetch` and `HOSTAPI_DISPATCH_TABLE`, entry by entry.

The shared gate helper is `src/plugins/isolation/__tests__/sandbox-cases.ts`. The Python
smoke serves `escape_secrets` (with its own-data control) and `escape_network` beside
`echo`, and its golden was re-recorded for the larger tool list.

*Lock suites.* `packaging-discipline-source.test.ts` reads executable discovery from
`scripts/lib/packaged-executable-selection.mjs`, which the packaged smoke and the gate
share, pins the gate's workflow step, and pins the gate's own environment allow-list;
the rest are unchanged.

##### Plugin-side slices (G0, G1, C1, C2, C3)

Planned outside this document: plugins that are not in the official index
prepare their own prerequisites, publish through another marketplace source and
release from their own CI. No host slice waits for them.

##### O1. The official marketplace switch

`src/marketplace/sources/official.ts:27-32` → `url: "https://github.com/ken-jo/agent-marketplace"`
(or the repository's public location if it moves), `auth: Object.freeze({ kind: "none"
})`, and the file header's "while this design is being built the repository is private"
paragraph (`:5-11`) replaced by the as-built sentence. The test that pins the constant
(`src/marketplace/sources/__tests__/`) changes with it. **Merge gate (decision 58):**
the repository is public — `gh api repos/ken-jo/agent-marketplace --jq .private` is
`false` and an anonymous `git ls-remote` succeeds — and the owner says so; until then the
PR exists as a draft and 0.14.0 ships with the token constant if the gate is unmet,
exactly as 0.13.0 did. Lock suites: `settings-store` and `packaging-discipline-source`
unchanged (the constant is not a setting); no channel or error changes.

##### O2. The E2′ carry-over

Unchanged from §9.7 E2′, restated for what it waits on: (1) the official repository's
`contract/` re-vendor from `v0.10.0` to the `v0.13.0` tag (adding the protocol schema
and the TS client) and `tools/vendor` from `8ccbbf3fe` to `v0.13.0` (rebuilding
`marketplace-check.js`, adding `ave-plugin-validate.js` and
`ave-plugin-child-main.js`), after the candidate wave merges — both need the wave
pushed and the official CI green, which runs (fact 10: the official repository's Actions
run; its daily job is red only at the ave clone); (2) the mirror promotion of `2/v0.12.0` and
`2/v0.13.0` (`node scripts/sync-plugin-host-protocol-mirror.mjs --publish 2/v0.12.0`,
then `2/v0.13.0`; decision 39 makes the order irrelevant to the alias) in a `web/**`
PR, after each release's draft is published — which needs the tag builds
(`build-installers.yml`) and so **GitHub Actions on `former_org`**. The daily
`published` job of the official repository stays as it is: it is correct, a
repository-scoped `GITHUB_TOKEN` cannot read another organization's repository, adding a
personal token would put a credential into a workflow to work around a platform flag,
and a public repository must be clonable anonymously — the fix is the owner's Support
ticket (decision 58). `TODO.md` records it as blocked by the flag, with the first failing
run.

##### R1. The 0.14.0 release PR

As E1′ (§9.7): `scripts/release.mjs` with `AVE_RELEASE_VERSION=0.14.0`; the
`CHANGELOG.md` entry ("every extension runs in its own process; the Doctor shows the
process and the confinement; the git extension's next version is required for its
cache directory and network declarations"); the mirror candidate as the release process
says (`docs/development/release-process.md:116-128`: Admission changes no protocol
schema, so the `2/v0.14.0` candidate appears with the bump and differs from `v0.13.0`'s
copy only by `$id`). Gates: the full suite and build once on the merged tree; fresh CI on the rollup with the three
confinement jobs; packaged smoke per OS with the Doctor fields visible. The 14-day
notice rule of §9.3 does **not** apply, because no protocol version is retired; that is
the whole reason. The release notes **do** carry a compatibility entry, because a
protocol-2 `entry` plugin outside the census changes arm (fact 12): "extensions
installed from a custom source, a folder or a direct install now run in their own
process; one that reached the network without `hostFetch` is blocked when the OS
sandbox is on (and reaches the network unmediated when it is off, as before); one that
used a home-relative path or Electron fails at that call; each needs an updated version
— the Doctor names the process and the confinement", with the note that a manifest
without a served `hostProtocol`, which only prepared activation or restart let through,
is now refused on those paths too (the child factory's check, `connectionHostProtocol`,
`out-of-process-plugin.ts:1057`), plus the `git` 0.3.0 requirement.

##### P7. Retiring the old server

Code (one PR per repository, in this order; blocked where noted) and owner actions,
after the plugin-side releases (decision 60):

| # | Step | Kind | Where | Blocked by |
|---|---|---|---|---|
| 1 | Public release of the app built on the git marketplace (0.14.0 or the first public build after it) | owner (release) | ave draft → published | GitHub Actions on `former_org` (tag builds) |
| 2 | Notice: the server's own announcements feed (marketplace design §16.1 "announcements → service endpoint"), and the 0.14.0 release notes; **fourteen days** before step 6, by the same rule §9.3 applies to a protocol boundary | owner (date) | server, release notes | — |
| 3 | `former_org/.github`: delete `marketplace-publish.yml`; `plugin-ci.yml` and `validate-plugin-manifest.yml` follow the archive wave in `TODO.md` | code | `.github` repository | nothing (a workflow file can be deleted without Actions) |
| 4 | Plugin repositories delete their GitHub publish workflows; the monorepo-moved repositories are archived in the wave | code / owner | plugin repositories | owner go-ahead (decision 49) |
| 5 | ave: nothing to delete (fact 11); `web/app/docs/marketplace/authors/page.tsx` is rewritten for `marketplace.json` with `schemaVersion: 2` and the `{ url, sha256 }` pin, with a custom-source layout as the example (fact 13) | code | ave `web/**` (deploys on merge) | nothing |
| 6 | Stop the server: `docker compose down` in `deploy/` with the volumes kept (`deploy_pgdata`, `deploy_mkt_storage`) until step 8 | owner | the server host | step 2's date |
| 7 | Cloudflare: remove the `marketplace.former-site.invalid` route/DNS record; the hostname answers nothing rather than a stale catalog | owner | Cloudflare | step 6 |
| 8 | Archive `former_org/agent-marketplace`, `marketplace-whitelist`, `ave-plugin-sdk` and the five moved plugin repositories; export the server's final catalog and package rows to `project-history/` first | owner | GitHub, `project-history/` | one release cycle after step 1 (`TODO.md`, the SDK retirement item) |

Nothing in P7 depends on the organization flag except step 1 (tag builds) and, through
it, the public date of step 2; steps 3 and 5 are code that can merge now; step 4's
plugin-repository deletions (`portal` C2, `git` G0) wait for the owner's go-ahead like the
rest of the plugin work (decision 49) and are not authorised by this table; and 6–8 are
dated by the owner.

#### Loader removal, restated after Admission (decision 59)

- **Condition (state, not date), the canonical statement (§9.3 refers here):**
  `allPluginsAreOutOfProcess` as fed by the registry is true on every Doctor report the
  owner has seen since Admission; the routing matrix, the official-index test **and the
  conformance suite of §10.1** (the goldens, the real confined child and the adversarial
  fixture) have passed on the release tags of **two consecutive app releases** (0.14.0
  and 0.15.0); and `importInProcessPluginFactory` and its tests have needed no change in
  those releases — verifiable in the history of `src/plugins/runtime/plugin-loader.ts`.
  The conformance requirement of the original §9.3 wording is kept, not amended; what is
  replaced is the census clause, whose subject no longer exists.
- **Owner:** the organization owner role (decision 5), recorded in `TODO.md` under the
  0.14.0 item when A1 merges: "in-process loader: deprecated at Admission (A1, #<PR>);
  removal condition §9.8; boundary 0.16.0".
- **Version boundary:** no later than **0.16.0** (two minor releases after 0.14.0), or
  the owner records why not in `TODO.md`.
- **What is deleted then:** `importInProcessPluginFactory`, `runPluginImportWithTimeout`,
  `PluginImportTimeoutError` and their tests; the `"in-process"` member of
  `PluginLoadArm` and its Doctor text; the knip baseline entry. `importPluginFactory`
  stays, as the child's. `OUT_OF_PROCESS_PLUGIN_IDS`, `isOutOfProcessPlugin` and the
  in-process import call in main are **Admission's** deletions now, not Loader
  removal's; §9.1 and §9.3 are amended to say so, and §9.3's citation of
  `ChildLocalPath` branches around `createHostApi` (`runtime/index.ts:2049-2058`) is
  withdrawn — no such branch exists at `c4c9689d2` (`createHostApi` serves both arms,
  and the out-of-process factory binds the dispatcher over the same object).
- **Not immediate work:** nothing in this plan opens the removal PR.

#### What the implementer must not decide

The arm of any plugin (there is one), the shape of the removal predicate, the four
escapes and their assertions, the `git` allow-list and the `~` rule, the custom-source
pin shape, the merge gate of O1, the retirement order. Each is a numbered
decision in §13 (48–62); an implementer who finds one unimplementable reports it as a
finding against the decision, and does not route around it.

#### Gates common to every host slice

As §9.7's: `bun run typecheck`; the narrow `bun run test:vitest -- run <dirs>` named
per slice, then the full `bun run test` and `bun run build` once on the merged tree before merge;
`check:knip:engine`; `.github/scripts/naming-gate.sh origin/main HEAD`; CI
`build-and-test` and `naming-gate` green on the rollup, plus the macOS and Linux
confinement jobs for A1 and A2 (Windows is measured on a provisioned host, above). No slice merges with a `test.skip`, a stub fixture or an
unimplemented branch standing in for evidence.

---

## 10. Validation strategy

### 10.1 Conformance tests (host repo)

1. **Schema ↔ dispatcher parity.** Every `HostApiPath` has a schema entry, every schema
   method has a handler, every error code in the schema is in the closed set. Modelled on
   `hostapi-effect-completeness.test.ts` (walks the real object) and
   `hostapi-serialization-conformance.test.ts` (every member is JSON-representable or
   owes a decision, `:1-20`).
2. **Golden fixtures.** One JSON request/response pair per method and per error code,
   replayed over in-memory paired streams against the real child runtime. Until §9.7 S1
   that is the in-memory substitution `out-of-process-plugin.test.ts:1-10` describes,
   made through the factory's `connect` member;
   from S1 the streams attach to the validation-only session entry
   (`openValidationSession`), and the production factory has no substitution point —
   only the observation-only `observeChild`, which sees the production child after the
   wrap and cannot replace it.
3. **Real confined child.** `confined-plugin-child.test.ts` keeps proving the
   confinement half with a real process (`out-of-process-plugin.test.ts:12-16`), on macOS
   and (from §9.7 P3) Linux; it gains the stdin-close-exits check without a termination
   call and the stdout-discipline check on the raw bytes, not on decoded frames.
4. **Adversarial fixture** (admission step): read `~/.ave/secrets/`, direct egress,
   `require("electron")`, monkey-patch a host internal, name another plugin's id, replay a
   lease id on another connection — each denied.
5. **Cross-language smoke**: a minimal Python plugin using a stock MCP server library for
   tools and a JSON-RPC library (or the generated client) for `ave/host/*` and
   `ave/instance/*` on the same stream passes 1-3.

### 10.2 Validating without the app: the validate CLI

`node tools/vendor/ave-plugin-validate.js <dir>` is built from the ave entry
`src/plugins/validate/cli.ts` as a `tools/vendor/` bundle, beside a second bundle of the
reference runtime (`ave-plugin-child-main.js`) it spawns for `entry` plugins:
`tools/vendor.mjs` already holds ave entries built with `bun build` by a recorded bun
version, byte-reproducible and hash-checked like the contract copies (`vendor.mjs:5-11`;
`tools/vendor/marketplace-check.js` is one today; after the candidate wave every such
entry is built by the silent-logger recipe, §9.7 fact 17), so a plugin repository takes it with
`vendor.mjs sync tools/vendor --ref <tag> --app <checkout>`. In the app repository the
same code runs as `bun run plugin:validate <dir>`. It replaces the per-plugin
drift scripts such as `plugins/meeting/source/scripts/validate-hostapi.mjs` in the
official repository (which imports the vendored `@ave/plugin-contract`, `:27`); the
slice is §9.7 P2 and the retirement is §9.7 E2′. It:

1. validates `plugin.json` against the manifest schema and the Ave `extensions` rules,
   including `requires.hostProtocol`, the protocol's first app version and, for a
   `process` entry, its path, environment-name and `minAppVersion ≥ 0.13.0` rules;
2. spawns the plugin with a plain child process the CLI owns (JS through the bundled
   reference runtime, or its `process` entry; no sandbox, decision 30) and attaches it
   to the validation-only session entry `openValidationSession` with a **validation
   host** that serves the real dispatch table with recording handlers, bound to the
   plugin's **base envelope** as its stated authority (§9.7 S1; declared `sandbox`
   grants are reported not exercised). The sequence is the host's own:
   `ave/instance/construct` first — the host never sends an MCP request before
   construct, and the reference runtime refuses one (`plugin-child-main.ts:308-319`) —
   then `start`, `server/discover` (versions and capabilities, **not** tools),
   `tools/list` (the tools), `tools/call` where arguments are available, each MCP request
   carrying the required `protocolVersion` and `clientCapabilities` metadata, an
   unknown-method probe, the plugin's `stop` hook alone, then stdin closed with no
   termination, and the host side released only after the exit is observed or its
   failure recorded. It asserts the protocol rules: framing and stdout discipline on the
   raw bytes, the request metadata, exit on stdin close, `-32601` for an unknown method,
   construct's `requires` within the advertised capabilities;
3. cross-checks `emitEvent`/`onEvent` names against the manifest's declared events and
   `bridge.callTool` targets against `app`-visible tools — the event and bridge checks
   the meeting script does today (`validate-hostapi.mjs:10-17`); its `permissions`
   checks are not carried over, because the host enforces no `permissions` entry;
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
3. **Capability ownership as a design rule** (one plugin owns one service's or one
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
| 2 | `resolveApiKey` stops exporting the raw key on its default path: `bearer()` leaves the contract, the default result is an opaque `ApiKeyLease`, `hostFetch` gains `init.auth = { lease }`, and a host provider key crosses **through `resolveApiKey`** only under `capabilities: ["secrets:raw-api-key"]` with receipt-bound consent (§4.1.1, §4.1.6). The guarantee is scoped to `resolveApiKey`; own-namespace `getSecret`, `portal`'s partition-cookie export and `readEncrypted` plaintext are the inventoried exceptions (§4.1). | The credential attaches at the egress chokepoint the way partition cookies already do; the capability makes the exception visible to the user and countable by the host. Neither official consumer needs it: `meeting`'s STT egress goes through `hostFetch`, and `local-indexer`'s worker traffic already reaches `hostFetch` through its JS broker, which gains lease attachment (decision 10). The earlier text that said `local-indexer` "forwards the bearer itself" was stale at `6a4d3b3`. |
| 3 | Out-of-process admission is decided the same way on every platform and for every install source — official, managed, custom, direct, local development, and origin-less legacy entries (`legacy-plugins.ts:90-93`). A code plugin loads out of process under the confinement the host chose for its workers: `features.pluginWorkerConfinement` (`features.osToolSandbox` until the 0.14.1 split; that setting now covers host shells only), off by default on every platform (`sandbox-gate.ts:20-21`); while it is off the child is spawned unwrapped (`out-of-process-plugin.ts:13-21`). What admission promises is the process boundary — separate heap, no Electron, own crash domain, one structural chokepoint — not OS confinement; OS confinement is whatever the substrate publishes (`architecture.md:1017-1020`): filesystem, process and network on macOS and Linux, filesystem and network on Windows. Only a non-JS `process` entry requires a wrap whose `confines` includes `process`, so it never loads on Windows and does not load anywhere with the sandbox off (§2.2). The Doctor's plugin report names, per plugin, the confinement it runs under. | An earlier draft refused custom and direct code plugins on Windows and admitted official and managed ones. Rejected on evidence: `origin.sourceOrigin` alone is not evidence, because the registry file is user-writable and `src/plugins/registry.ts:300-311` checks only shape, legacy migration binds `official` by plugin id with `artifactSha256: null` (`legacy-plugins.ts:95-124`), and a removed `additional` source leaves `managed` behind, so a sound version would need the host-secret evidence chain (`grants.ts:87-106`); it would grant the official and managed sources a privilege the marketplace design forbids (§10: the badge is the only thing the official source grants; §10.5); it would refuse `portal` and `git` on Windows, since neither is in the official index (`marketplace.json` at `6a4d3b3df` lists `hello-world`, `local-indexer`, `meeting`, `mail`, `assistant`) while `portal` already runs out of process there (`out-of-process-plugins.ts:857`); and its rationale was false by default on every platform, because with the sandbox off macOS and Linux run a custom plugin without process confinement too. |
| 4 | A non-JS `process` entry is in the manifest schema from protocol `1` (`schemas/plugin-manifest.schema.json:1121`). Its runtime and a **narrow** marketplace admission — a sha256-pinned `release` or `archive` artifact recorded in the receipt, a live sandbox whose `confines` includes processes, never Windows, `minAppVersion ≥ 0.13.0` — ship in Publication (0.13.0, §9.7 P3-P4). Out-of-process-by-default admission for every install and the adversarial fixture stay in the Admission step. | The protocol is language-neutral from its first published version. The earlier wording deferred all marketplace admission for `process` to the Admission step, which contradicts the Publication scope (§9.1, §2.1's pinned-artifact rule); what the adversarial fixture must precede is admission of unpinned or unconfined code, and that stays refused on every path (decision 35). |
| 5 | The deprecation owner of the in-process loader is the organization owner role of `former_org` (the repository's sole maintainer) — a role, recorded as such in `TODO.md` when the wire step starts; ave has no `CODEOWNERS` file. | AGENTS.md requires a named owner and a removal condition for any coexistence (§9.3). |
| 6 | The protocol schema is canonical in the ave tree at a release tag and vendored like the rest of the contract (§6.3); its `$id` carries the app tag; ave.agent-connector.ai mirrors every copy `mirror.json` records from `web/public/schemas/` (published, candidate or orphan, each frozen against its own hash, §6.1), with `/1/protocol.schema.json` as a documented moving alias for editors. The validate CLI is a `tools/vendor/` bundle built from an ave entry (§10.2). | A release tag plus a sha256 in `contract/sources.json` is what the contract already pins; `tools/vendor.mjs` already holds bundles built from ave entries with a recorded bun version (`vendor.mjs:5-11`); release assets would be a second publication of the same bytes. The tag in `$id` is what keeps an additive revision (§3.3) from changing the bytes behind one identifier, since the site deploys on every `web/**` merge, not on tags. |
| 7 | Per-plugin resource limits on macOS are deferred: crash containment ships first, and the conformance suite records RSS and startup time per plugin. | No number exists to size an `RLIMIT` against. |
| 8 | **Release target (owner, 2026-09-27).** Lease ships in **0.12.0** (X). v0.11.0 ships first with its current scope (wire and alerts). Official plugins publish their alerts versions first and bump again for Lease, with no combined bump; a published artifact is never rewritten (§9.5). | Lease is a protocol boundary with its own notice, replacement and matrix gates; folding it into a release whose scope is already fixed would either skip those gates or reopen that release. The version number itself is not the gate. |
| 9 | **Installed-plugin cutover (owner).** Announced hard cutoff with pre-activation refusal: X serves protocol `2` only; a code plugin whose manifest does not declare a served `requires.hostProtocol` — including one that declares nothing — is refused before factory activation on both loader arms and for every install source, with a clear status and an update path. The rule is generic, never keyed to a plugin id or a method heuristic; `minAppVersion` is never an upper bound. §3.2's retention promise is rewritten; the cost, the notice and replacement gates and the old/new matrix with downgrade are in §6.4 and §9.3 (§9.5 for the sequence). | Retaining `1` would mean a second frozen runtime, schema set, codec, child stub and envelope policy, which the generator (`plugin-host-protocol-schema.ts:317-324`) and the single bound dispatch table (`out-of-process-plugin.ts:1423-1444`) cannot express by adding an array element; a version label that does not select an implementation is not compatibility. Omission cannot keep meaning "newest" on X because the newest is incompatible with the bearer the old bundle calls (`host-api-child.ts:342-394`; `meeting` `plugins/meeting/source/src/hostPlugin.ts:1911`). Postponing X when the gates are unmet is what protects users; a runtime fallback would hide the break. |
| 10 | **local-indexer path (owner).** The existing JS egress broker in the plugin child gains host lease attachment: broker → `hostFetch` with `auth.lease`, one lease per upstream request, acquired before the relay and released in `finally` after the buffered response body completes, the worker's abort linked to the use's signal. Plugin-owned-key mode stays. The lease-mode host-key `getSecret` fallback and the bearer-length availability check are removed from the plugin; host-side the same read is refused by the gate's `export` rule (decision 17), not by deleting entitlement rows (§4.1.6-4.1.7). No raw exception exists because a Python SDK is present. | The worker never held the shared key on the production path (`workerClient.ts:472-474`, `embedding_client.py:159-167`); the only raw reach is the JS channel callback. A maintained per-channel lease needs refresh/revoke state and would let query-time search reuse a stale scan handle; per-request is one resolve and one release notification per call, priced in §7.4 and revisited only on measurement. |
| 11 | **Sandbox location (owner).** `extensions["ai.agent-connector.ave"].sandbox`, a sibling of `requires`, `capabilities`, `networkAccess` and `alerts`; carried through the descriptor and index with equality checks, the install review and upgrade deltas, the receipt, and the official repository's checker, re-vendored. `ceilingSubtractions` keeps subtracting the closed host catalog globally; a missing declaration gets only the base envelope (§2.2). | Authority is what the marketplace pins, reviews and holds equal; a block outside the extension object would be invisible to that pipeline, and a block nested under `requires` or `capabilities` would change the meaning of two closed objects. |
| 12 | **Lease shape.** `ResolveApiKeyResult = ({ ok: true } & ApiKeyLease) \| ({ ok: true } & ApiKeyRaw) \| ResolveApiKeyDenied`; `leaseId` = wire `handleId` = subscription id, one opaque host-minted string (`lease_`/`raw_` prefixes); `release()` is an idempotent one-way notification that aborts active uses and never throws; `onClosed` accepts any number of listeners and replays to a late one; the reference runtime parks a `closed` that precedes adoption; the result axis becomes `handle-or-denied`; raw returns `key` bytes and says they cannot be recalled; `HostFetchInit.auth = { lease }` exactly, **forwarded by the dispatcher to the factory's single `hostFetch`**, turned into a credential-use context there, and absent from the transport init (§4.1.1). | One identifier removes a mapping table and lets the existing subscription release/closed notifications carry the lifetime. Stripping in the dispatcher would leave the in-process arm on a different enforcement path; the factory is the only place both arms meet. A `bearer()` thunk on the raw branch would pretend to revoke copied bytes. |
| 13 | **Lifetime.** `issuing → active → released \| revoked`, `peer-gone` only at incarnation or connection end; no wall-clock expiry; the record carries incarnation, permission epoch, secret generation and provider-configuration revision, and every use re-checks all four after each await; revocation on permission revoke, secret write/rotation/removal/withholding, active-vendor/endpoint/preset change, plugin update/disable/uninstall; active uses aborted, bytes already sent not recalled; `opts.signal` cancels the resolve request only; ≤ 32 registrations per incarnation, reserved at entry (§4.1.2). | Event-bound lifetime has no race a timer would fix; today nothing closes an issued ledger entry on any of these events (`host-api-dispatcher.ts:795-832` opens it, `host-api-factory.ts:813-816` only passes the revoke accessor into the resolver), and one host registry owned by the plugin-runtime step is the code path both arms share. |
| 14 | **Audience and scheme.** Keyed by the host's normalized source record, not the request union: `openai` → `Bearer`, `azure-foundry` → `api-key`, `claude` → `x-api-key`, each at the origin the host's own adapter uses (configured base URL, else the public default; Azure with no base URL is `endpoint-unavailable`); `gemini` and `vertex-ai` are `vendor-unsupported` for lease in 0.12.0 (Vertex authenticates with ADC, not a stored token); plugin-own keys → the plugin's allow-list. Origin match, `https` only, no path binding; empty intersection with the allow-list denies at resolve. Lease mode keeps the guard's independently approved loopback/private exceptions and adds no network rule of its own. Per hop: clear the closed `CREDENTIAL_HEADERS` (`authorization`, `proxy-authorization`, `cookie`, `api-key`, `x-api-key`, `ocp-apim-subscription-key`) on any origin change, re-check liveness, re-inject only inside the audience, otherwise refuse the redirect (§4.1.3). | The plugin's allow-list authorises the plugin's traffic, not the host's key; the current three-header strip (`host-fetch-guard.ts:475-478`) lets an `api-key` cross origins, reproduced by the cross-review. Relabelling a stored Vertex string as a token, or refusing every private target the guard already admits for the corporate Azure case, would each be a false claim about the host. A silent unauthenticated downgrade on redirect would turn an audience violation into a confusing provider error. |
| 15 | **Conflicts.** No lease: caller headers pass, so `mail` OAuth, `portal` cookies, plugin-key modes and the FFmpeg download keep working, and a non-vault caller `Cookie` still passes. Lease: any caller credential header, **`Cookie` included, vault-declaring or not**, is `credential-conflict`; a malformed `auth` is `credential-conflict` at every layer. Lease + host-injected partition cookie: allowed only when both grants independently cover the URL; cookie prepared, liveness re-checked, then injected (§4.1.4, full matrix there). | A blanket `Authorization` ban breaks valid non-lease callers; two reviewed grants for one URL are a stronger statement than a prohibition; leaving the non-vault caller-Cookie cell undecided would let a plugin pair its own session with the host's key. |
| 16 | **Errors.** Four thrown codes join the closed set: `lease-unavailable` (one code for unknown, foreign, raw, released, revoked and stale-epoch, no oracle; never raised by `release()`), `lease-audience-denied`, `credential-conflict`, `rate-limited` (`retryAfterMs` ≤ 5000). Resolver outcomes stay `ok: false`, with six new reasons. Audit is coalesced per `(plugin, method, code)` with a 60 s summary; transport failures get a fixed public message and a bounded `data.kind`, not a sanitiser. Broker → HTTP 403 terminal / 429 / 499 / 502; worker retries only 429 and 502-504 (§3.6, §4.1.5, §4.1.7). | Distinguishing foreign from unknown handles would let a plugin probe another's handle space; a 504-for-everything broker and a worker that retries broad `APIError` classes would turn a denied lease into repeated requests and a silent degraded search; a per-raise audit would let a refused flood do unbounded work; a regex cannot prove credential bytes are absent from arbitrary text. |
| 17 | **Raw scope and the export rule.** `secrets:raw-api-key` gates `resolveApiKey({ exposure: "raw" })` only. The shared secret gate gains an operation axis: `getSecret` is `export`, refused for the host-provider secret class for every plugin before the read; `resolveApiKey` is `lease`, which keeps the unchanged tiers including the entitlement rows (`grants.ts:41-44`) and provenance (`:87-111`, `secret-gate.ts:190-215`) for both exposures; raw adds the capability in the reviewed authority and a receipt reviewed on app version ≥ X; every denial precedes the secret read (§4.1.6). | Deleting the entitlement rows was rejected because `getSecret` and the resolver share one gate that denies a missing row before provenance, so the rows' removal would deny every host-key lease; an operation rule by secret class is generic and needs no plugin-id branch. An inert string in an old artifact was never shown as a privilege, so its bytes cannot be consent for one. |
| 18 | **Publication prerequisites advanced into Lease.** Protocol-aware catalog selection (`hostProtocol` in descriptor and index, a `host_protocol` exclusion), final-tag contract and checker sync, the protocol schema as a vendored artifact (so `portal`'s two-file inventory changes). The TS client and the validate CLI stay in Publication (§6.3, §6.4). | The `"2"` pin needs the bytes it pins and a sync must not offer what the app cannot run; the client and CLI are conveniences with no compatibility consequence. |
| 19 | **Publication sequence.** One timeline: tested candidates and the 14-day notice before the tag → app tag with the installer release held as a draft (E1) → re-vendor from the tag → publish plugins, pins and both index files → packaged matrix against the published artifacts → publish the app draft → promote the schema alias (E2, the alias names the newest copy `mirror.json` marks published, §6.1, §9.7 M1); alerts versions first, Lease versions after, no combined bump; `assistant` revocation stays with 0.11.0 and a revoked plugin is outside the replacement set (§9.5, §6.4). | The draft release (`build-installers.yml:308-316`) separates tag creation from rollout, which is what lets replacements exist before an old artifact can be refused; a replacement vendored from a tag cannot be required before that tag, so the earlier "replacements before the tag" wording was circular and is withdrawn. |
| 20 | **Budgets.** The numbers of §7.4: 50/s default, `hostFetch` 20/s, `resolveApiKey` 10/s, notifications dropped and counted, 64 in flight, 256 subscriptions with per-kind caps, 32 leases; keyed by plugin id, cleanup exempt; dispatcher-only scope stated. | Sized from the configured 400 RPM indexer batch rate as an input with ~3× headroom, to be confirmed by the measured acceptance run; not from the number alone. |
| 21 | **Multipart and upload budget.** The reference runtime serialises `FormData` to bytes with a generated boundary, counting as it appends and refusing before over-allocation; the 16 MiB cap is the entire serialized body and stays; 15 MiB is `meeting`'s audio target under it with non-file fields bounded; the direct 25 MiB upload route joins the staged route's segmentation for anything that would exceed the budget, the staged 500 MiB limit stays, and both return the structured `file-too-large` result (§8). | A `FormData` body is refused by the encoder today, reproduced by the cross-review; raising the cap would move the frame and memory bounds for every member to fix one caller; lowering only the staged segment check would leave the direct route sending 25 MiB in one request. |
| 22 | **git.** The "all mediated / no ambient axis" claim is withdrawn; direct `fetch` and the `~`-expanded external `dataDirectory` are Admission prerequisites, not Lease work (§9.1, §9.2). | Source at `d71fb95` shows two global `fetch` sites and a home-relative cache; keeping `git` in process during Lease does not make those Lease's to fix, and claiming isolation from a method list would be false. |
| 23 | **Slicing.** Host PRs A, B, C, D, E1, E2 of §9.6: B independent; C ships the sandbox authority and format-2 catalog while **retaining** `PLUGIN_ENVELOPE_GRANTS` as the source for undeclared artifacts (owner: the organization owner role; removal condition: D); D is the single protocol-2 boundary that serves `2`, retires `1`, refuses undeclared and `"1"` manifests and deletes the table; E1 is the pre-tag release PR; E2 is the post-tag runbook whose gates are on the published release. | Each slice is coherent at its boundary; the places a slice could hide a break are named and forbidden: a typed `auth` field without enforcement in D, a deleted table while protocol `1` is still served in C, and a tag whose creation depends on receipts vendored from itself in E. |
| 24 | **Catalog format 2** (superseded 2026-10-14: one `marketplace.json` with `schemaVersion: 2` inside, no frozen format-1 file, any other version refused). As first decided: a frozen format-1 file for pre-X apps beside a format-2 index carrying every version with `hostProtocol` and `authority.sandbox`; descriptors gain `schemaVersion: 2` (§6.4). | The index root, version and authority objects are closed and a package is validated whole, so any new field in the shared file drops every version of that package from every older client, which would break the "old app keeps its old versions" promise the downgrade and rollback rows depend on. A presence-declared format is deterministic; a tolerant reader or a retry is not. |
| 25 | **Approved-root withdrawal.** A resolved envelope has two inputs, manifest authority and the approved-directory ceiling; when either stops covering a running incarnation's grants the runtime retires that incarnation and its delegated workers before the change is acknowledged, marks `sandbox-grant-outside-ceiling`, and refuses a restart until the config or the ceiling changes; overlapping roots keep a grant; the boot reconciler runs before plugins load (§2.2). | The kernel envelope cannot narrow after spawn (`out-of-process-plugin.ts:682-687`) and root removal already revokes permission signals (`permission-manager.ts:1148-1155`), so an update-only rule would leave a child using a withdrawn root until its next restart. |
| 26 | **Linearised issuance.** `issuing` starts before the first authorization await: resolve the key identity, capture `{ incarnation, permissionEpoch, secretGeneration(key), providerConfigRevision }`, reserve a registration slot, run the gate and reads, then compare-and-register in one synchronous section or deny `stale-authorization` and return the slot; the store gains generation hooks at every transition of the state the resolver can see — the in-memory provider-configuration mutation before its save, the rollback after a failed save, every change of secret readability, and the completion of a secret write or delete — never only on successful commits (§4.1.2). | Counters alone do not say which snapshot a lease represents; without a reservation, concurrent resolves can all observe 31 and exceed the cap; re-reading into a new epoch would silently launder a stale authorization; the store makes a configuration visible before it is saved and restores the saved one when the save fails (`settings-store.ts:1114-1116`, `:1978-1993`), so a post-commit counter would leave a lease bound to a rolled-back endpoint usable. |
| 27 | **Publication slicing (§9.7).** P0 design; P1 client, M1 mirror alias rule and S1 protocol-session seam independent of one another; P2 validate CLI and P3 `process` runtime after S1; P4 marketplace admission and P5 cross-language smoke after P3; E1′ the 0.13.0 release PR; E2′ the post-tag plugin-repository sync, drift-script retirement and alias promotion. **One fixed merge order**, P0 → S1 → P1 → M1 → P3 → P2 → P4 → P5 → E1′ (M1 done: #2591, `9c56ec148`), with development parallel after S1; every shared file follows it (the later slice rebases and integrates). The one slice that changes the protocol schema is P3 (the `PluginManifest` wire change, decision 33), which refreshes the open `2/v0.13.0` candidate and the client in the same PR. | The mirror check freezes the canonical schema on `main` between a tag and the next bump, and #2589 made that bump the first change after v0.12.0 (§9.7). The first round let P2 and P3 start at once against one factory and they required incompatible behaviour of it (both reviews' P0); freezing the session interface in S1 first is what lets P2, P3 and P5 proceed in separate checkouts without inventing a bypass. The second round's "any order" beside an ordered file matrix was two orders (host re-review #24); a single order with P1 before P3 and P3 before P2 removes every conditional ("if P1 merged", "the second of P2 and P3"). |
| 28 | **The TS client carries no app version** and is generated from the committed schema, not the TS sources; `json-schema-to-typescript` 15.0.4 is the one new dev dependency; the client is vendored by sha256 from the tag and not mirrored on the site. | A file that embedded the app version would change every release with no method change; the schema is the published artifact, so a client provably projected from it is one any language can reproduce; the mirror exists so `$id` resolves for editors, and a second web copy of the same bytes is the duplication decision 6 rejected. Rejected: a compiler-API type printer (a second projection of the sources with its own drift). |
| 29 | **`HOST_PROTOCOL_FIRST_APP_VERSION`** (`{ "2": "0.12.0" }`) beside `HOST_PROTOCOL_VERSIONS_SERVED`, held by a test to the lowest `appVersion` recorded for that protocol in `mirror.json`; the validate CLI enforces `minAppVersion ≥` it. | §9.4 item 6 promised the rule to the validate CLI; a constant read from the mirror's history is derivable and gated, where a literal in the CLI would drift. |
| 30 | **The validate CLI does not confine the child, and never reaches the production factory.** It spawns a plain process and attaches it through `openValidationSession` (`src/plugins/validate/validation-session.ts`, owned by the validate directory), the validation-only entry to the protocol-session layer `openPluginProtocolSession` that S1 extracts; the conformance goldens use the same entry. `createOutOfProcessPluginFactory` keeps admission and `spawnConfinedChild` with **no** substitution point and no bypass flag (`OutOfProcessPluginSpec.connect` is deleted; its only test seam is the observation-only `observeChild`, decision 43), and an import-boundary test proves nothing under `src/plugins/runtime/`, `src/boot/` or `src/main/` reaches `src/plugins/validate/`. The validator's authority is explicit: a table bound to the plugin's base envelope, with no declared grant applied (decision 43). Confinement is the host suite's (§10.1 item 3). | A validator that wrapped would need ASRT and the host's sandbox state on the author's machine, including Windows; a green wrap there would prove nothing about the host's, and a red one would block authors on a substrate they do not ship. One factory cannot both refuse every unconfined process launch and serve an unconfined validator; separating the session layer from admission and spawning lets each keep its rule. Rejected: an `unconfined` or `validationMode` flag on the factory (a bypass reachable from a runtime path). |
| 31 | **`tools/call` in the validate CLI** is issued with `{}` for tools with no `required` input, from `--tool-args` for the rest, and reported `not exercised` otherwise, never failed. | A generic validator cannot invent meaningful arguments; a failure it cannot justify would train authors to ignore it. |
| 32 | **`process.command` is inside the plugin root only** (`./` or `${PLUGIN_ROOT}/`); the schema pattern and the hardening refuse a bare name; §2.1's earlier "bare executable name" is withdrawn. | §7.3 already ruled out a `PATH` search for a marketplace plugin, and a `process` entry exists only as a marketplace plugin (§2.1); two rules for one field would leave the schema admitting what the runtime refuses. |
| 33 | **The protocol change Publication makes is the `PluginManifest` wire type**, which construct carries (`plugin-instance-wire.ts:82`; `protocol.schema.json:7116-7117`): the public type becomes the exclusive union `EntryPluginManifest \| ProcessPluginManifest` (each branch declaring the other's key `?: never`), and the schema generator projects a `never` property as a `false` subschema, so the wire schema rejects both and neither (today `entry` is in one object's `required` list, `:7503-7508`). Construct's `entryPath` stays required and is, for a `process` launch, the resolved absolute command path; its description is amended. P3 regenerates the schema, the `2/v0.13.0` candidate and the client in one PR and adds a process-launch construct golden validated against the regenerated schema. | A `process` manifest cannot cross construct without the type change; the first round's "only the `entryPath` description changes" and "the client changes only when methods change" were both wrong, since the client projects every `$defs.types` entry. Making `entryPath` optional would be an additive change a `2` client tolerates (§3.3) but a second shape for one field with no consumer that needs it. Two optional properties would project to a schema that accepts both keys (host re-review #20); the generator drops `never` properties on its own (§9.7 P3), and a rule keyed to `never` in the source is general where a `PluginManifest` special case would not be. The open candidate permits the change (§9.7, mirror freeze). |
| 34 | **No new descriptor or index field for `process` in 0.13.0.** Admission reads, per version, `platforms` (present, without `win32`), the declared `release`/`archive` sha256 pin with no `tree`, and `minAppVersion ≥ 0.13.0` (decision 38), and trusts the **verified** rung the receipt records; the declared pin is only what makes that rung reachable. `ExpectedPlugin` gains `platforms` and `artifact` and every producer fills them. The sandbox-off refusal on macOS and Linux is pre-activation but post-download. A `runtime` field is the first candidate for a catalog format 3. | Format-2 version and authority objects are closed and a package is dropped whole by a 0.12.x app when one version carries an unknown field (decision 24), which would remove every process-entry package, old versions included, from every 0.12.x client; `platforms`, the pins and `minAppVersion` already reach catalog selection (`catalog/aggregate.ts:85-89`). |
| 35 | **One provenance gate on every activation path.** `assertProcessEntryAdmitted(manifest, verified)` runs first in `importPluginFactoryForLifecycle` (`runtime/index.ts:5143`), before routing, and every caller passes its own verified evidence: boot preflight, `instantiateAndStartSinglePlugin`, `restartPluginInternal`, and `activatePreparedArtifact`, which verifies the staged `receiptRaw` with `verifyInstallReceiptRaw` first. `PluginIntegrityCheckResult.verified` gains the receipt's `rung`. A `process` manifest passes only with `installSource: "git"`, rung `release` or `archive` and a non-null `artifactSha256`; everything else that reaches the gate, including a `local-dev` receipt under dev unlock and a valid receipt the path did not verify, is `process-entry-requires-pinned-artifact`. **Precedence:** receipt integrity first (a directory with no receipt is refused there, fail-closed, before the manifest is read at boot and before materialisation elsewhere), then this gate, then routing, then the sandbox check at spawn. The gate lands **in P3**, with the runtime it guards, and is tested per path, the precedence cases included. | All four paths reach the factory through that one function (§9.7 fact 8), and the integrity result dropped the rung, so a gate on the marketplace install path alone would leave an on-disk tree-rung or hand-placed process manifest able to run through boot, restart or prepared activation. Rejected: keeping `process` refused in P3 until P4 — the gate needs nothing from the marketplace, and shipping the runtime without it would create a state where the runtime exists behind a refusal that a later slice must remember to replace. Rejected: a manifest-aware classification before the receipt check so a no-receipt directory gets the process code (host re-review #22's alternative) — it would read and classify bytes no receipt vouches for, on a failure path, to change only the message. |
| 36 | **No manifest byte reaches the confinement wrapper's environment.** Manifest `env` names pass `isSafeMcpEnvironmentName` (`src/mcp/safe-names.ts:50-53`: `RESERVED_ENV_NAMES` case-insensitively, the launcher family, and `PLUGIN_ROOT`/`PLUGIN_DATA`, whose comparison P3 makes case-insensitive too) at hardening, install, load and in the CLI. The spawn runs `/usr/bin/env <manifest pairs> PLUGIN_ROOT=… PLUGIN_DATA=… <command> <args>` **inside** the wrap, the host-owned pair after the manifest pairs so it is authoritative; the outer wrapper sees `buildSafeChildEnv()` and the sandbox HOME only. `=` is refused in `process.command` and in a resolved command path. An interpreter path such as `PYTHONPATH` is set by the plugin's own launcher inside confinement, from `PLUGIN_ROOT`. Negative tests prove `BASH_ENV` and `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES` placed below the hardening execute nothing before confinement. | With the sandbox active the outer executable is ASRT's `/bin/bash -c` wrapper, which reads `BASH_ENV` from its own environment before the sandbox command runs (§9.7 fact 9), and `buildSafeChildEnv` lets extras override host variables. Reusing the MCP rule keeps one reserved-name list. Rejected: a process-entry name list of its own (two lists drift); passing declared variables through `extraEnv` (they reach the outer shell); a `PYTHONPATH` exception in the host (the reviewer's example, withdrawn because the name is reserved and the launcher can set it inside the wrap). |
| 37 | **Two contained-path rules for a `process` entry.** The executable is anchored by `anchorBundledCommand`: realpath inside the retained generation, `O_NOFOLLOW`, a regular file. An `args` element or `env` value beginning `${PLUGIN_ROOT}/` goes through a new `containedRootPath`: relative segments only, the path must exist, its realpath lies inside the root, and it may be a file or a directory. `${PLUGIN_DATA}` tokens keep `containedDataPath`. Other `args` literals keep the resolver's undeclared-path rule; other `env` values are opaque literals without `${`. | A vendored tree is a directory, and `anchorBundledCommand` refuses anything but a regular file (`plugin-bundled-command.ts:56-58`); the artifact is immutable, so a missing root path is a manifest error, while a data path's leaf may not exist yet. |
| 38 | **`PROCESS_ENTRY_FIRST_APP_VERSION = "0.13.0"`**, separate from `HOST_PROTOCOL_FIRST_APP_VERSION["2"] = "0.12.0"` (decision 29). A `process` manifest must declare `requires.minAppVersion ≥ 0.13.0`; hardening, the validate CLI, the ladder's manifest rules and the repository checker (per released version) enforce it. | Protocol `2` began at 0.12.0 but no 0.12.x app has a process runtime; catalog selection filters by `min_app_version`, so the floor is what keeps a 0.12.x client from selecting a version its runtime refuses. |
| 39 | **The mirror alias for a protocol always names its newest published copy**, enforced whether or not a candidate is open; promotion (`sync-plugin-host-protocol-mirror.mjs --publish <protocol>/<version>`) sets `publishedTag` and writes the alias from the maximum published version. M1 lands before either Lease's `2/v0.12.0` promotion or the `2/v0.13.0` promotion. | The check skipped the newest-published rule while a candidate was open (`plugin-host-protocol-mirror.mjs:107`), so a late `v0.12.0` promotion after the next bump could move alias `2` backwards unnoticed, and without a candidate the old "move the alias to that entry" instruction would fail after a `v0.13.0` promotion. Enforced order-independence removes the ordering constraint between two runbooks owned by different steps. |
| 40 | **Stdout discipline is proven on the raw bytes, and the production decoder stays tolerant.** The validate CLI and the confined-child suite tee stdout and fail on any line that is not a JSON object terminated by `0x0A`, including a `Content-Length:` header; `StdioFrameDecoder` still drops such a line in production. | The decoder drops malformed lines by design (`stdio-framing.ts:35-46`), so counting decoded frames cannot see a violation. A strict production decoder would turn a stray line into a failed plugin for every installed plugin mid-release, a contract change with no notice or replacement path; the reference runtime already takes stdout away from plugin code, and the validator catches a non-JS plugin's violation before publication. |
| 41 | **Plugin resource cost is measured on the child, not on the test runner.** The confined-child harness samples the spawned wrapper's process tree with `ps` every 50 ms from spawn to exit (RSS in KiB on both platforms) and records peak RSS and spawn-to-construct time for the Python smoke and the `meeting` fixture; the Python child also reports its own `ru_maxrss` as `params.meta.ruMaxrss` of its last log notification, normalised per platform, and the golden canonicalises exactly that field to `"<measured>"` after recording its raw value, and replaces the temporary plugin and data roots (as allocated and after `realpath`) and the validation context's `hostRoot`, `userHome` and `aveHome` with named placeholders, guarded by a throw if `os.tmpdir()` or the checkout root survives; the repeat-run byte-equality check records twice with independently allocated roots and compares both to the committed golden. The numbers are reported, not gated, and the UNVERIFIED item stays open until a run produces them. | `process.resourceUsage()` reports the calling Node process and its peak persists across tests (Node documentation, <https://nodejs.org/api/process.html#processresourceusage>, checked 2026-09-28); a gate sized before any measurement exists would be a guess (decision 7). An RSS value in a golden would fail it on unchanged wire behaviour (cross-language re-review 4); a rule keyed to one field keeps every other number exact. A `mkdtemp` root differs on every run and is outside `goldenPath`'s fixture root, so without its own rule the golden holds a path no other run can produce, and a repeat run that reused one root would not notice (cross-language re-review round 3, finding 2). |
| 42 | **Retired sources are outside validation by absence, not by a skip list.** The official repository's validation targets are the tracked sources that remain after the candidate wave (`feat/lease-candidates`, `e53fb40a8`), whose commit `0835fd2` deletes `plugins/assistant/source` and keeps its entries in both catalog files and its revocation entries. E2′ item 1 waits for that wave; the CLI then runs unconditionally for every discovered directory. | The revoked plugin is outside the replacement set (§9.5) and its source cannot pass protocol-2 validation; a lifecycle flag or skip list would be a way to switch validation off, while deleting the source leaves nothing to skip and keeps the catalog and revocation records that clients still need. |
| 43 | **The protocol-session layer's authority is an input, and its controls are split by consequence.** `openPluginProtocolSession` requires a `BoundHostApiDispatchTable` — branded, produced only by `createBoundHostApiDispatchTable`, which moves to `bound-host-api-table.ts` — and never derives or defaults an envelope. Production binds it to **the same envelope value** the spawn received; the validation host binds it to `validationConfinement`, the plugin's base envelope with no declared grant applied and no read of the user's approvals. The session returns a non-destructive `channel` (`requestMcp`, `probe`, `runStopHook`, `closeInput`, `exited`) and one destructive `teardown`; `instance.stop` is `runStopHook` then `teardown`, unchanged in production. `teardown` is the only destructive call: a child that exits by itself is observed (`onGone` → the transport's `peerGone`), and the session releases its watchers, pending calls and dispatcher state and runs `onClosed` once **without** `terminate`; a deadline or a fatal framing error still reaches `close` and terminates. `onGone` is terminal-only — an exit, or an `error` from a spawn that produced no process — and an `error` on a live child (a failed signal delivery) goes to the required `ChildLink.onFault`; the transport starts at most one termination sequence (`link.terminate`, flagged before the call because a refused `kill()` emits its `error` synchronously), a fault with no sequence active starts it through `close`, and a fault during it is only recorded — the link's own SIGKILL after the grace period is the retry, and a refused SIGKILL leaves `exited` unsettled with no further signal; `channel.exited` settles only on an observed exit. Both openers take an optional `signal` honoured from their first line, so a caller can cancel while construct is pending; an abort is `teardown`, and a construct success that races it is torn down, not returned. The production factory's only test seam is `observeChild` (`pid`, `onStdout`, `endInput`, `exited`), called after the wrap; it cannot supply, replace or re-spawn the child, see the envelope or table, write a frame or terminate. All of this is frozen in S1, and S1 migrates the 28 `connect` consumer sites. | `createServiceHostApiPaths` makes the envelope required because an omitted one "would silently mean 'unbounded'" (`host-api-dispatcher.ts:1352-1360`); a session that derived its own could check delegated workers against something other than the jail (`out-of-process-plugin.ts:157-165`), and a validator that read `~/.ave/config/settings.json` would validate against one user's approvals (both re-reviews' P0). The factory's `stop` always terminates (fact 14), so a stdin-close test built on it measures the termination, not the rule (host re-review #18, cross-language re-review 2); and while `onGone` is wired to `close` (`plugin-child-transport.ts:154-156`), a natural exit also calls `terminate`, which the third round found the second round's text still allowed (host re-review #25, cross-language re-review round 3, new 1). Both process adapters forward every `error` to `onGone` today (`out-of-process-plugin.ts:973-982`, `child-process-config-wire.test.ts:218-222`), while Node emits `error` for a signal it could not deliver to a running process (<https://nodejs.org/api/child_process.html#event-error>, checked 2026-10-01) and `managed-child-processes.ts:109-113` already keeps such a child; treating that as an exit would release a live child and let `closedReason` swallow its termination (host re-review #28). The opener returns the session only after construct (`out-of-process-plugin.ts:1436-1446`, `:1544`), so a caller's deadline that fires during construct had nothing to cancel with (host re-review #29). Re-terminating on every fault recursed: `terminateChildProcess` sends SIGTERM before arming its timer (`terminate-child-process.ts:16-30`), so `terminate → kill → error → fault → terminate` nests without bound (cross-language re-review round 5, reproduced with Node's own `kill`). Rejected: re-terminating on a fault after `close` (that recursion); a separate `cancelConstruct()` handle (a second cancellation path beside `teardown`); making `signal` required (production's factory timeout already disposes a late instance). The confined suite needs the real child's bytes, PID and stdin (fact 15); a seam that could substitute the child is the bypass decision 30 removed, one that only observes after the wrap is not. Rejected: a pre-bound table passed as a plain `Record` (a hand-built or unbound record would type-check); an envelope input to the session (it would bind the table itself, a second binding site); an `unconfined` flag (decision 30). |
| 44 | **One producer of MCP request metadata on the plugin-child channel.** `PluginChildTransport.requestMcp` stamps `_meta` with `io.modelcontextprotocol/protocolVersion: "2026-07-28"` and `io.modelcontextprotocol/clientCapabilities: {}` on `server/discover`, `tools/list`, `tools/call` and `resources/read`, and refuses a caller `_meta`; `request` takes `ave/instance/*` only and `ave/*` frames carry no MCP `_meta`. `clientInfo` is omitted. Decision 63 adds a third key, `ave/invocation`, on `tools/call` only. The reference runtime's tolerance of a missing version is unchanged; the Python fixture rejects a request missing either required key with `-32602`, and the validate CLI checks the host-side frames. Landed in S1 with the goldens regenerated. | MCP `2026-07-28` makes both keys required on every request and a request without them malformed (fact 16); the factory sent neither on `tools/call` or `resources/read`, and a tolerant runtime hid it. `{}` is truthful: the host serves no server-to-client MCP request on these pipes (`plugin-child-transport.ts:242-247`). `clientInfo` is a SHOULD, display-only and self-reported; an app version in every MCP frame would move every golden at each release. Rejected: making the reference runtime strict in 0.13.0 (it also serves the in-process loopback, whose internal caller it tolerates by design, `plugin-mcp-server.ts:233-237`, and a behaviour change for every installed plugin is not Publication's); stamping in the session instead of the transport (two call sites, and the validator's requests would need a third). |
| 45 | **Vendored bundles use the official repository's post-wave recipe, and the host logger is silent in them by intent.** `ave-plugin-validate.js` and `ave-plugin-child-main.js` are `tools/vendor/` `build` entries with `logger: "stub-app-logger"`, built by `bundle-app-marketplace.mjs` via `buildAtRef`; the portal and repository plugins adopt the same recipe byte-for-byte; ave's bundle test runs that recipe from a fixture copy that names its commit. Source mode (`npm run plugin:validate`) applies the same substitution through `scripts/lib/stub-app-logger-hook.mjs`, a resolve hook loaded in the CLI and its child, and each mode's test parses every stdout line as a report row. | At the wave `vendor.mjs` refuses any other logger recipe (`:92`), so the pre-wave plain `bun build` the second round named could not be vendored (cross-language re-review 7). The app logger writes to stdout outside a headless run (`logger.ts:70-99`) and the CLI's stdout is its report; the child's diagnostics that matter cross as `notifications/ave/log`. Reproduced 2026-10-01: the recipe builds `plugin-child-main.ts` at `c73f59580` with no `pino` and no embedded path (fact 17). In source mode neither `LOG_LEVEL` nor rebinding `process.stdout.write` is enough: the logger's test-mode path calls `console.log` whenever `VITEST` or `NODE_ENV=test` is set (`logger.ts:37-38`, `:223-259`) and its pretty stream defaults to stdout (`:93-99`), so only replacing the module covers both (host re-review #27, cross-language re-review round 3, new 3). Rejected: a source-mode-only flag in the logger (a second silencing mechanism that the bundles would not exercise). |
| 46 | **The Python smoke provisions one interpreter in one tree.** Every uv call runs with `UV_PYTHON_INSTALL_DIR`, `UV_PYTHON_BIN_DIR`, `UV_PYTHON_INSTALL_BIN=0` and `UV_CACHE_DIR` under `node_modules/.cache/ave-python-smoke`, discovery is `--managed-python`, every job that runs the smoke ensures uv with `scripts/fetch-uv.mjs` before it, and CI supplies the interpreter through `AVE_SMOKE_PYTHON` from `actions/setup-python`, except the self-hosted macOS job, which takes the uv path so nothing installs outside its workspace. The launcher is tested by running `bin/plugin` under `env -i` and checking the imported `mcp` comes from `<root>/vendor`. | `--install-dir` alone does not tell a later `find` where to look, default discovery falls through to `PATH`, and from uv 0.8.0 an install links an executable into the user's `PATH` (fact 17; cross-language re-review 6). The confinement jobs had no uv step and a cache hit skips the postinstall (re-review 5). A preflight that sets `PYTHONPATH` itself cannot fail when the launcher forgets to (re-review 9). |
| 47 | **Every call the validate CLI awaits is bounded, by `runProtocolChecks`, from `TOOL_TIMEOUT_POLICY`, and cancelled through one `AbortSignal`.** Construct `pluginFactoryMs`, the runtime's activation bound (the session's 20 s `pluginImportMs + pluginFactoryMs` stays as the transport's cleanup deadline, not a validation bound); `start` the manifest's `startupTimeoutMs` clamped to `pluginStartupMaxMs`, else `pluginStartupDefaultMs`; `onPublished` the same value as validator-only policy, since the runtime does not bound it; `server/discover`, `tools/list` and the unknown-method probe `mcpRequestDefaultMs`; each `tools/call` `globalCeilingMs`; the stop hook `pluginStartupDefaultMs`; `closeInput` → `exited` 5 s; `--fast` caps each of these at 1 s. A CLI-owned `finally` always runs — also when an opener rejects and no session exists — through the run's `AbortController` and the CLI's link, which records the exit, faults and signals from spawn; it starts the link's one termination sequence (`VALIDATION_KILL_GRACE_MS` 3 s, production's) unless the child already exited and waits `VALIDATION_TEARDOWN_WAIT_MS` 5 s for the exit; `protocol.teardown` is always reported, never `not exercised` and never capped by `--fast`. Expiry fails that row with `timed out after <n> ms` and aborts the run's controller, which the session (given it as `signal` before construct) turns into `teardown`; every later row is `not exercised` and the exit code is 1. | The CLI drives the session directly, so the runtime's owners (`runStartWithTimeout`, `src/plugins/runtime/index.ts:1242-1256`; the executor ceiling, `src/tools/executor-ceiling.ts:56-76`) never run, and the transport sets no timer for a call without a deadline (`plugin-child-transport.ts:159-165`, `child-stream-multiplex.ts:287-290`): a child that answers construct and then goes silent would hang the CLI and CI (host re-review #26). Reusing the production values keeps a plugin that passes validation inside the bounds the app will apply: activation bounds the whole child construct, import included, by `runPluginFactoryWithTimeout` at `pluginFactoryMs` (`runtime/index.ts:1215-1227`, `:4007`, `:4912`, `:5528`, `:6282`, `:5151-5154`), so the round-3 bound of import plus factory would have passed a plugin the app refuses (host re-review #30). `onPublished` is awaited unbounded (`runtime/index.ts:3437`); its bound is labelled the validator's own policy rather than parity. Rejected: a single CLI-wide timeout (it would report no row and could not tell a slow `start` from a hung tool); bounds inside the session (the runtime owns production bounds, and a second owner there would race it). |

| 48 | **Distribution of plugins outside the official index (owner, 2026-10-03).** A plugin that is not listed in the official marketplace repository is distributed through another marketplace source, which users add as a custom source and administrators as a managed policy `additional[]` entry. The design plans no fallback to the official index for such a plugin. | The official repository's checker admits an official plugin only as a release asset of that repository (`tools/check.mjs:88-91`, `release.mjs verify`). |
| 49 | **Plan only for the plugin side (owner, 2026-10-03).** The plugin-side slices (G0, G1, C1, C2, C3) are planned outside this document. The host slices (A1, A2, O1, O2, R1, the code half of P7) are not held. | The host work has no dependency on the plugin work (fact 12 of §9.8). |
| 50 | **Routing has no input.** `importPluginFactoryForLifecycle` routes every `entry` manifest to `createOutOfProcessPluginFactory` unconditionally; `OUT_OF_PROCESS_PLUGIN_IDS` and `isOutOfProcessPlugin` are deleted at Admission with their pins; the in-process import becomes `importInProcessPluginFactory` in `plugin-loader.ts` with no production caller, carried in the knip baseline with the owner (decision 5) and the removal condition (§9.3), and Loader removal deletes it; `bustCache` leaves the lifecycle method. | A host-owned plugin-id table is a plugin-specific branch once the arm it selects is the only arm (AGENTS.md); keeping the in-process factory as dead-but-tested code for two releases is the deprecation shape §9.3 already defines, and a routing reversal is then a reviewed code change, never a runtime fallback. Rejected: an empty exclusion set as a dormant routing input (a branch no test can reach); deleting the arm in the same slice (it would collapse §9.3's two-release observation into nothing). |
| 51 | **The removal predicate is fed by the registry.** `LoadedPlugin` records `arm: PluginLoadArm` from the routing function's return; `allPluginsAreOutOfProcess(loaded)` is true when every arm is `"child"`; the Doctor's plugin entry shows `arm` and `confinement` (`PluginConfinementReport`: the spawn's `SpawnConfinement`, or `"not-spawned"` for a construction that failed before a child existed); the "official index" clause of §9.1 is a test that routes every manifest of the committed official index to `child`. | The old predicate was a lookup in the census it existed to retire; a predicate over what actually loaded is what makes §9.3's condition checkable without fleet telemetry, and the Doctor fields are what decision 3 promised the user. |
| 52 | **No migration shim for installed plugins.** On 0.14.0 every installed plugin loads as a child — every protocol-2 `entry` plugin outside the census (third-party, folder and direct installs) **changes arm**, and the release notes say so (R1); one whose child cannot be spawned or wrapped fails the load with the factory's existing error and the Doctor's `arm`/`confinement`, and is not retried in process; one that used an ambient capability fails at that call; the fix is the plugin's next version and the status's existing update path. A manifest with no served `hostProtocol` that reaches the routing function through prepared activation or restart is refused by the child factory's check inside the invoked factory; A1 reports it from the invocation catches (`runtime/index.ts:5141`, `:6443`) with the boot/add audit event — an update's refusal reaches the Updates card as the existing `PACKAGE_INCOMPATIBLE` / `host_protocol` failure (translated at `src/plugins/marketplace.ts:956`), a restart's reaches the config-save reply and the card's optional `lastAttemptRefusal` — never through `markLoadRefused`, and tests both the reporting and the untouched incumbent generation on both paths. No manifest field, setting or environment variable selects the arm. | Protocol 2 proves compatibility of the contract, not independence from ambient capabilities, so the earlier "no running plugin changes arm" claim was too strong (fact 12); decision 9 still refuses every pre-protocol-2 plugin before activation, and boot and add refuse an unserved version explicitly, but prepared activation and restart do not (the lookups at `runtime/index.ts:4962` and `:6374`; the check runs when the factory is invoked, `:5021` and `:6422`), and the factory's check (`out-of-process-plugin.ts:1057`) is the one gate every path shares after A1; a refusal that marked a running plugin failed would misreport the incumbent, so the report goes to the attempt's own surface. A per-plugin opt-out would be the routing input decision 50 removes. |
| 53 | **The adversarial fixture** lives at `src/plugins/isolation/__tests__/fixtures/adversarial/`, attempts the four escapes through `escape_secrets`, `escape_network`, `escape_electron`, `escape_patch`, asserts only where the harness claims confinement (`expectConfined`), is built first against the validate CLI (which asserts "no usable main-process API" by shape and the stdout discipline, and records the host-call probes) and then gated under the real wrap through the production factory, with the production secret gate, audit sink and `hostFetch` guard, on macOS, Linux and Windows with control cases that must pass first. The Electron claim is "no usable main-process API", never "no version" or "import throws" (the child is `process.execPath` under `ELECTRON_RUN_AS_NODE=1`); its positive control is a separate full Electron main process (`control-electron-main.cjs`, the same binary with `ELECTRON_RUN_AS_NODE` removed; under `xvfb-run` on Linux CI), never the test process, which runs as Node itself; the planted `electron` entry lives outside bare-specifier resolution (`vendored-electron/`, as the confined suite does) and the fixture is staged outside the checkout; the packaged gate's control is the packaged application's main process, launched through Playwright's Electron driver against the installed build with the gate's own environment allow-list (no `ELECTRON_RUN_AS_NODE`, no profile of its own) and evaluated with `app.evaluate`, because a packaged executable without `ELECTRON_RUN_AS_NODE` starts the application, not a helper — a development-helper result is never packaged evidence; the secret claim is `null`, no bytes, a denial audit under the spawn-bound identity and an own-namespace positive control (production `getSecret` returns `null` on denial, `host-api-factory.ts:984-987`). Escapes 1–2 are added to the Python smoke. | The validator never confines (decision 30), so a filesystem or socket claim there would be false; the wrap suite is where the host's claim is made, and a probe that cannot be shown live is no evidence (a failed control fails the file). The first draft asserted a wire error code for a denial and an undefined Electron version, both contradicted by the production launcher and the existing measurements (`confined-plugin-child.test.ts:1487-1515`); the second took the test process as the Electron control, which runs under `ELECTRON_RUN_AS_NODE=1` (`run-vitest-under-electron.mjs:154`) and so measures the trap, not the API, and put the planted package where a bare `require` would resolve it. |
| 54 | **`git` 0.3.0 prerequisites.** Egress through a once-bound `hostFetch` that throws when absent (no global `fetch`), caller `Cookie`/`Authorization` headers kept (no lease, §4.1.4), `authCookiePartition` not adopted (two partitions), a static `networkAccess.allowedDomains` of a GitLab host, `github.com`, `api.github.com`, `api.openai.com`, `openai.azure.com` with `allowPrivateNetworks: true`, and a configured LLM endpoint outside it refused, never widened from config; `dataDirectory` as a `sandbox.write` `userChosenDirectory` grant, `~` refused by the plugin's tools with one sentence where plugin code runs and by the host's resolver at spawn with the host's generic guidance ("enter an approved absolute directory, or clear the setting", added by A1 for every key), the stored value rewritten by nobody, recovery tested; `requires: { minAppVersion: "0.12.0", hostProtocol: "2" }`; retired manifest fields dropped; published only after these, so #27 (0.2.2) is superseded. | The allow-list is manifest authority the marketplace pins and reviews (decision 11), so a config-driven widening would be authority the review never saw; the host's resolver already refuses `~` (`out-of-process-plugin.ts:408-427`) but names no way out, and a host-side rewrite of one plugin's setting would be a plugin-specific branch; a plugin that cannot run cannot migrate its own value, so the host's generic sentence names the setting and both acceptable actions. |
| 55 | **Another marketplace source** carries `marketplace.json` (`schemaVersion: 2`) and `plugins/<name>/ave-package.json` descriptors pinned with `artifact.release: { url, sha256 }`, built with the official generator's rule. Its layout is the plugin side's concern. | `marketplace.json` is the only index the app reads (decision 24). |
| 56 | **Releases from the plugin's own CI.** A plugin outside the official index releases from its own CI with no publish credential in the release job; publication is a reviewed pin in its marketplace source. | Keeps the released artifact and the code that releases it apart. |
| 57 | **Installed-package migration to another source uses no new mechanism**: the §16.3 unmanaged notice, binding through policy `additional` + `requiredInstalls` (slice F), or a user-added source and an ordinary source switch (§16.4). | Everything needed merged in #2550–#2558 and #2615; a plugin-specific migration in the host would be a branch the architecture forbids. |
| 58 | **The official switch and the daily job.** `official.ts:27-32` becomes the public URL with `auth: { kind: "none" }` and merges only after the repository is public (anonymous `ls-remote` succeeds) and the owner says so; 0.14.0 ships with the token constant otherwise. The official repository's daily `published` job is left as it is; its failure since 2026-09-25 is the organization flag (anonymous 404 on a public repository), fixed by the owner's Support ticket, not by a token in a workflow. | A credential added to work around a platform flag outlives the flag; a repository-scoped `GITHUB_TOKEN` cannot read another organization's repository anyway; and a public repository that cannot be cloned anonymously is the defect, not the job. |
| 59 | **Loader removal, restated.** Condition (canonical in §9.8, "Loader removal, restated after Admission", which §9.3 cites): the registry-fed predicate true on every Doctor report seen since Admission; the routing matrix, the official-index test and the §10.1 conformance suite green on the release tags of two consecutive releases (0.14.0, 0.15.0); and no change to `importInProcessPluginFactory` in those releases; owner: decision 5's role, recorded in `TODO.md` when A1 merges; boundary: 0.16.0 or a recorded reason. Not planned as immediate work. | §9.3's shape — its two-release conformance requirement kept — with the subject it now has. |
| 60 | **P7 order.** Public release → fourteen-day notice (§9.3's rule, applied to the server) → `.github` `marketplace-publish.yml` deleted → plugin repositories' GitHub publish workflows deleted → the web author page rewritten for format 2 → server stopped with volumes kept → Cloudflare route removed → repositories archived one release cycle later with the catalog exported to `project-history/`. Steps 3 and 5 are code and can merge now; step 4 is plugin-repository code that waits for the owner's go-ahead (decision 49); 1 waits for Actions; 2, 6–8 are the owner's. | Users must have the replacement source before the old one answers nothing; the catalog export is the only record of what the server served. |
| 61 | **0.14.0 carries no protocol boundary.** Admission changes no protocol schema; the `2/v0.14.0` candidate differs from `v0.13.0`'s copy by `$id` only; §9.3's notice rule does not apply to the release, only to the server (decision 60), because no protocol version is retired. | The arm change is inside the host's promise (§2.1); the notice rule is keyed to a retired protocol version, and none is. What 0.14.0 does refuse anew — a manifest without a served `hostProtocol` on the prepared-activation and restart paths (fact 12, decision 52) — is the rule 0.12.0 announced for every path, now applied by the child factory's check, and R1's release note names it. |
| 62 | **Migration of old-server installs of plugins outside the official index (designer, 2026-10-08).** Such a package can be **required** through policy (`requiredInstalls` from its source): a package that is not installed is installed by the boot step, and an existing install is switched through the idle apply queue after boot, never by an immediate boot install. `defaultInstalls` is not the migration path, because it skips an existing package bound to no source. An unmanaged install migrates by an explicit user-driven source switch. | Uses only the mechanisms of decision 57. |
| 63 | **An out-of-process tool's hostApi call runs in its host invocation.** The transport mints `_meta["ave/invocation"]` for each `tools/call` and keeps an `AsyncLocalStorage.snapshot()` of the caller's context. It keeps the snapshot for the life of the connection: settled calls are kept too, up to `SETTLED_INVOCATIONS_MAX` (1024, oldest dropped first). Live calls are never evicted; excess calls are refused before capture at `LIVE_INVOCATIONS_MAX` (64), so the tables retain at most 1088 snapshots. Close and observed exit release both tables before fallible termination or subscription teardown (`plugin-child-transport.ts`). The child runtime binds the token for the handler's async chain, including work the handler leaves running, and stamps it on each hostApi request (`plugin-child-runtime.ts`). The dispatcher runs a request in the snapshot its token names, refuses a token the connection does not hold, and runs a tokenless request in a context captured at module load, where no store is entered (`runOutsideInvocation`, `host-api-dispatcher.ts`). The transport also routes every frame off the pipe through that context. Residual: a child can still omit the token and run a gated write ungated. The host does not refuse it, but logs the first qualifying write per gated path per connection while a `tools/call` is in flight; repeated writes emit no more warnings. The module-load guard rejects both effect-gate and invocation-origin frames, including app-only tools without a gate frame; boot must still evaluate it outside unrelated stores. Additive within protocol `2` (§3.3). Pinned by `invocation-context.test.ts`, over a link that delivers in its spawn context, and by `plugin-child-transport.test.ts`. | After Admission A1 every entry plugin runs as a child. A child's hostApi request reached the host in the context of the pipe, not the invocation, so `gateMutatingEffect` read "no invocation" and passed every gated write unasked. A plugin tool's `raiseAlert`, or any other host-classified write, skipped both the foreground approval and the headless deny (blueprint `plugin-process-isolation.md` §7 Q5 expected it to survive the boundary). The pipe's context is the one the child was SPAWNED in, not a neutral one. A child restarted from inside a tool call (`config.set` → `restartPlugin`) would run every tokenless request of its generation in that finished invocation: a headless deny, a foreground allow-once grant and session attribution, and a growing effect ledger. Rejected: dropping a call's context when it settles (a handler's timer then ran fail-open, while in-process the same code is denied headless); gating every child write that has no context (it would also gate lifecycle work an in-process plugin does freely); refusing a tokenless gated write while a call is in flight (honest background work runs beside tool calls, and the host cannot tell the two apart); exiting individual stores instead of using one root context (the pipe also carries the install-lock, registry and lifecycle stores, and a list of stores to exit goes stale). |
| 64 | **Windows: plugins are not isolated from each other (owner, 2026-10-10).** On Windows every plugin, third-party ones included, runs in the one shared `srt-sandbox` identity: sandboxed from the host as configured, not from each other. The app adds no install gate, warning or confirmation, serialization of plugin processes, or marketplace-source restriction on Windows; the sandbox capability report says "against the host" there (`permissions.ts` `sandboxCapability`, `sandbox-capability-info.ts`), and every inter-plugin claim in this design and the blueprint is scoped to macOS and Linux. The same holds for the host's own READ grants there: a bundled hook or MCP stdio server whose program lives in `<AVE_HOME>/runtime` holds READ on that directory for its lifetime (`wrap-bundled-command.ts` `hostRuntimeReads`), and while held every confined process reads it too — acceptable because the runtime is the host's shipped interpreter and holds nothing private. It is an accepted risk, pending an ASRT per-plugin (per-execution) identity, and is re-decided when one exists (§9.8 A2, *As implemented*). | ASRT 0.0.80 runs every sandboxed process as one account, without restricting SIDs; its allows are session-level grants and its per-execution denies holder-refcounted ACEs, both on that account's SID, so a deny between plugins takes each plugin's own directories from it as well, and a grant to one is visible to all while held. Upstream `@anthropic-ai/sandbox-runtime` releases through 0.0.80 (checked 2026-10-19) add no per-execution identity. Rejected by the owner: an install gate, warning or confirmation for third-party plugins on Windows, serializing plugin processes, and restricting Windows to some marketplace sources — third-party plugins run on Windows. Rejected on the facts: a deny-based partition, which removes each plugin's own access (above). |
| 65 | **The HostApi `storage` surface operates in a host-only directory (owner, 2026-10-10).** Every `storage.*` member — and the webview bridge's `ui-storage/` through `getPluginStorage` — resolves `<pluginsRoot>/<id>/storage`, a sibling of `data/` and `sockets/` owned by `plugin-storage-layout.ts` (`PLUGIN_HOST_STORAGE_DIR_NAME`, `resolvePluginHostStorageDir`). It is in no confined process's write envelope on any platform: `derivePluginChildEnvelope` refuses a write grant that is the directory, inside it or an ancestor of it (`writeGrantsReachingHostStorage`), and the Windows ACL holder grant is checked against the same rule. It is runtime state like `data/` (`PLUGIN_RUNTIME_DIR_NAMES`: excluded from the receipt, never copied as payload, refused in an upload) and is carried with `data/` by `carryPluginStateDirs` through promotion and recovery; uninstall and tombstones remove the whole plugin root, so they cover it with no new path. `storage.rm({ recursive: true })` is a plain recursive `rm` there. Existing state is migrated once at boot, before `initPluginRuntime` and before any confined process may run (`migratePluginHostStorage`): `data/` is **copied** — only what can be a storage key: regular files at key depth 2 or less (`name`, `dir/name`: `auth/token-….json`, `ui-storage/<key>.json`, top-level JSON) of 8 MiB or less (owner, 2026-10-10), judged by `lstat`, never through a link (`O_NOFOLLOW_ANY` on macOS, `O_NOFOLLOW` plus a `/proc/self/fd` identity check on Linux); deeper entries, larger files, links, special files, hard-linked files and unreadable entries are skipped and counted in the boot audit — into a staging directory renamed to `storage/` in one step, and `data/` is left untouched. A root that has `storage/` is done; a plugin load refuses to invent an empty `storage/` beside a non-empty `data/`. | A storage op checks containment and then issues a path-based syscall; while the directory was the child's own `data/`, the child could rename a parent aside and plant a link in that window, and all eleven ops at depth 2 followed it (read, write, list, create or delete outside the root). No platform offers a path-based "no link in any component" for every op — macOS has it for `open` only, Windows for none — so the only per-platform-complete fix is a directory the child cannot write. Copy rather than move because a file written through `storage` cannot be told from one the child wrote, and the plugin's own code addresses both by the same relative names: the copy rebuilds the storage view as it was, and the child's own reads of `data/` keep working. Not hard links, which would cost no space: the `storage/` name would share a file object the child still writes through its `data/` name, and on Windows the child could turn that file into a symlink reparse point and re-point the host's path. The depth and size caps keep what a plugin keeps for itself in `data/` — `meeting`'s session transcripts, staged uploads and WAV segments, an index workspace — out of `storage/`, where a copy would outlive the plugin deleting its own and show up in `storage.list`; what remains is a one-time copy of small top-level and depth-2 files. Residuals, each accepted: a storage value an older version wrote deeper than depth 2 or larger than 8 MiB is not migrated; a value an older version writes to `data/` after the migration (a downgrade, then an upgrade) is not migrated again, because a root with `storage/` is done; and a confined child of a crashed previous run that outlives it could swap a parent between the migration's `readdir` and its descent — a directory listing taken there names outside entries, but every file is opened with no link in its path and checked against its `lstat`, so nothing outside is copied. A directory is made in `storage/` only when a file is copied into it, so a skipped tree leaves no empty key namespace behind. A load refused for a root whose migration failed names the failure and the path. On Windows the migration has no no-follow primitive and relies, like every boot sweep of a child-writable tree, on running before any confined process of this app. |
| 66 | **A Windows ACL grant names an envelope root, never a path below one.** `srt-win acl grant` canonicalises its input and stamps the `(OI)(CI)` ACE on what the path resolves to — measured on ASRT 0.0.76 on a provisioned host: a write grant on `data\link`, a junction, landed `(OI)(CI)(M)` on the junction's target. Every component below an envelope root is the plugin's own process's to re-point, between any check and the grant. So a delegated worker's `allowReadPaths`/`allowWritePaths` are granted as the outermost envelope root containing each (`decodeWorkerSpec`, `outermostContainingRoots`), after the containment check that refuses a path outside the envelope; the plugin child's own grant likewise names only its outermost roots. On Windows both containment questions are asked on the canonical form admission asks on (`isGrantPathWithin`: `canonicalizePathForMatch`, which expands 8.3 short names and follows links, then `caseFoldForMatch`), so `…\DATA\work` or an `IKCHA~1` spelling of a path below a root is that root, and a path a link re-points outside every root is refused. A `userChosenDirectory` value inside `data/` is folded into `data/` itself at derivation (`resolveUserChosenDirectory`): it adds no reach, and no root is left below `data/` to be granted on its own. | An lstat walk of the components cannot close it: the plugin's process can plant the junction after the walk. What the outermost root rests on depends on the root. `data/` and `sockets/` are directories the host created under `plugins/<id>/`, whose parent no confined process can write, so they cannot be re-pointed. A chosen directory or a `hostDirectory` root is not host-made: it rests on the user's approval and on no confined process holding write on its parent — and where one plugin's chosen directory contains another plugin's, the outer plugin's child does hold it, because every confined process runs as the one sandbox account; that is decision 64's shared-account residual, which this decision neither adds to nor closes. Granting the root widens nothing on Windows for the same reason: the worker reaches only what the plugin's own process already does. Hard links are a residual of the inheriting grant itself. A hard link's file has one security descriptor, so a link `data\h.txt` naming a file outside gains inherited Modify when `data\` is granted (measured). Creating such a link needs `FILE_WRITE_ATTRIBUTES` on the target — measured on Windows build 26200 with a non-administrator token (Administrators deny-only, able to write `data\`, owner of the target): `mklink /H` was refused with `(R)` on the target and succeeded with `(R,WA)`; `srt-sandbox` is in Users and sandbox-runtime-users only, and the token's High integrity does not enter a DACL check. So a confined child cannot turn a file it can only read into a writable one; what remains is a file outside the envelope the sandbox account can already write attributes of (another plugin's live write root, decision 64), which gains inherited Modify when this plugin's root is next granted, and a link an administrator or the user placed in `data\`. A spawn-time refusal of files with link count above one is not made: it is a walk of every write root on every spawn, it cannot tell a package installer's hard-linked install from an escape without matching file ids across trees it does not walk, it races a live child of another plugin over a shared chosen directory, and what it would stop the child creating, the child already cannot create. The storage migration copies no file with a link count other than one (decision 65). macOS and Linux keep the path, under ASRT's own normalisation. |

### Owner decisions still open

None as design decisions. Decisions 8-11 and 22 record the owner's decisions of
2026-09-27, decisions 48-49 those of 2026-10-03 and decisions 64-65 those of 2026-10-10 (66 is the designer's, of the same day);
decisions 12-21, 23-26, 27-47 and 50-62 are the designer's, made so the implementer decides no security or migration
semantics, and each review round's findings are either resolved above or rejected in
the section they name; decision 5 names a role, not a person, so nothing waits on the
owner. The owner delegated the Publication decisions (27-46, and 47 under the same
delegation) on 2026-09-28; the lead's guidance of the same day on the two Publication
reviews fixed the shape of decisions 30 (the separate session layer), 35 (provenance
on every path), 36 (reserved environment names), 39 (order-independent promotion) and
42 (retired sources); the lead's guidance on the two re-reviews (2026-09-28, answered
2026-10-01) fixed the shape of decisions 43 (explicit session authority, split
controls, observation-only seam, all frozen in S1) and 44 (one host-side producer of
MCP request metadata), and the single merge order of decision 27.

**Owner actions** (by role, not design decisions; §9.8):

- Making `linux-confinement-tests` a required status (open since §9.7 P3), and
  `windows-permission-tests` with it once A1 merges.
- Making `ken-jo/agent-marketplace` public (or moving it), which gates O1.
- The GitHub Support ticket for the organization flag, which gates O2, R1's tag builds
  and P7 step 1.
- The fourteen-day notice date and the server stop, Cloudflare and archive dates of P7.
- Recording the loader-removal owner line in `TODO.md` when A1 merges (decision 59).

---

## UNVERIFIED in this document

- The RSS and wall-clock startup cost of one plugin child (§8). No measurement exists in
  the checkout; the conformance suite is asked to produce it — §9.7 P5 records it for
  the Python smoke and the `meeting` fixture in the confined-child run.
- Resolved 2026-09-28 (§9.7, "Facts this plan rests on"): `ts-json-schema-generator`
  2.9.0 is the generator's engine in production and the committed schema is its output;
  the stock MCP server SDKs speak `2026-07-28` (`mcp` 2.0.0 stable on 2026-07-28, 2.2.0
  current; the TypeScript 2.x packages), with the stdio drivers owning the pipes, so the
  Python smoke owns its stream and hands the library one message at a time.
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
- (§9.8) The exact filesystem error each substrate returns for an unbound read
  (`EPERM`/`EACCES` on macOS and Windows, `ENOENT` under bubblewrap is the expectation;
  Windows measured `EPERM` under srt-win on 2026-10-10, row 1a included — §9.8 A2);
  A2's assertions are per platform and the first run fixes the values.
- (§9.8 A2) An `uvx`-launched MCP stdio server under srt-win, end to end. The relay, the
  `<AVE_HOME>/runtime` read grant and the relayed environment are measured with Node
  programs; uv fetching an interpreter and packages through srt-win's proxy is not.
- (§9.8) The Electron positive control on Linux CI under `xvfb-run` and on the Windows
  runner. macOS is measured (2026-10-08: Electron 44.3.0, `BrowserWindow` `"function"`,
  `app.whenReady()` resolves, `session.defaultSession` `"object"` — a development-executable
  result); the other two are recorded by A2's first CI run, as are all three
  packaged-control values (the packaged application's main process evaluated through the
  installed-build driver; a development-helper result is never packaged evidence), and a
  helper or packaged control that does not start fails the file rather than passing it.
