# Plugin HostApi as a versioned protocol

Plugin names such as `mail`, `portal`, `assistant` and `ave-plugin-repo` in this
record are generic stand-ins for plugins that are no longer part of this project.

The code packages described here are called extensions in user-facing copy.

**Released contract.** Released hosts serve protocol `"3"`, introduced by
0.14.0 on the `ave/*` wire. Published plugins continue to declare
`requires.hostProtocol: "3"` and `requires.minAppVersion: "0.14.0"`.

**Unreleased contract.** This development build serves protocol `"5"` only
(`HOST_PROTOCOL_VERSIONS_SERVED`, `src/plugins/isolation/host-api-wire.ts`).
Protocol 5 keeps protocol 4's host-generated state on plugin loopback OAuth
callbacks (§3.3.1) and replaces delegated-worker control sockets with worker stdio
control v1 (§3.3.2). Protocol 4 was never released. The owner decision of
2026-11-02 holds the next app release for this change, so released hosts move
from protocol 3 straight to protocol 5 in one cutover; protocol 4 is not served
beside it. The app release version is selected by release preparation,
independently of the protocol major. No first published app version is recorded
for protocol 5; `requires.hostProtocol` negotiation determines support, and
released protocol-3 hosts reject protocol-5 packages before activation regardless
of `minAppVersion`. Its schema/client and wire fixtures live under
`schemas/plugin-host-protocol/5/` and
`src/plugins/isolation/__tests__/fixtures/host-protocol/5/`.

The unreleased protocol 5 surface also removes unused lifecycle, discovery,
logging, proposal and approval members. Diagnostics use stderr; host shutdown
closes stdin before the existing termination escalation. Extension events reach
only the emitting extension’s UI, and manifest cross-extension event grants are
removed. `config.get`, `config.set` and `config.onChange` remain: lifecycle config
writes cannot safely restart their own active lifecycle operation, so removing
the change subscription would leave the live child’s config snapshot stale.
Historical implementation plans below may name retired members; the current
surface is the §4 table and the generated protocol-5 schema.

The existing unreleased-candidate convention (§6.1) stores the new schema under
`web/public/schemas/plugin-host-protocol/5/v0.14.2/`, with
`publishedTag: null`. That version segment identifies the open schema candidate,
not an announcement that 0.14.2 has shipped protocol 5. The protocol-4 candidates
(0.14.1 and 0.14.2) are retained byte-for-byte with their original hashes and
generation commits as superseded, unpublished copies. Historical protocol-3 schema
copies remain unchanged. Publish protocol-5 plugin replacements only with
the coordinated app release; use its actual release tag and minimum version.
Numbers in the historical plans below describe those steps, not this candidate.

Status: design, decided; the wire step ([§9.4](../history/plugin-hostapi-protocol-migration.md#94-the-wire-step-implementation-plan)) is implemented on `main`; the Lease step
([§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps), §4.1, [§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19)) was amended on 2026-09-27 with decisions 8-26 (§13), in two rounds
of independent review, and shipped as v0.12.0; the Publication step has its
implementation plan in [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) (2026-09-28, decisions 27-47) and targets 0.13.0; Admission
([§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan), decisions 48-62) and the move to protocol `3` on the `ave/*` wire target 0.14.0. It follows
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
documentation. The Lease amendment (§2.2, §3.2, §3.6, §4.1, §6.1, §6.3-6.4, §7, [§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps)-9.3,
[§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19), decisions 8-20) cites ave at `f1a8d191e` (main, 2026-09-27, after the wire
step), the official repository at `6a4d3b3`, `ave-plugin-portal` at `2f17388` and
`ave-plugin-repo` at `d71fb95`; a citation in those sections without a repository name is
ave at `f1a8d191e`. The Publication plan ([§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan), and the §2.1, §6.1, §6.2, §10.2
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
  and when it leaves the set, the routing census and the conformance fixtures of [§9.4](../history/plugin-hostapi-protocol-migration.md#94-the-wire-step-implementation-plan)
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
[§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan)) — with `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expanded in `args` and `env` and both
variables set in the child environment
([Agent Plugins §9.1](https://agent-plugins.org/specification)). `PLUGIN_DATA` is
`pluginDataDir` (`public-contract.ts:2153`). The schema branch, the hardening rules and
the spawn are the P3 slice of [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan). A `process` entry is admitted only for an
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

The filesystem envelope was `{pluginRoot, pluginDataDir, socketDir, workerRunRoot}` for
read and `{pluginDataDir, socketDir}` for write (`out-of-process-plugin.ts:717-723` at
`f1a8d191e`). Host protocol 5 dropped `workerRunRoot` and its Unix-socket allow: workers
speak stdio (§3.3.2), so the read base is `{pluginRoot, pluginDataDir, socketDir}`. Widening it today is a host-side table keyed by plugin id
(`PLUGIN_ENVELOPE_GRANTS`, `:322-368`), whose only entry is `local-indexer`. The Lease
step ([§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps)) deletes that table and moves the declaration into the manifest, as a
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
prerequisite, not a Lease grant ([§9.2](../history/plugin-hostapi-protocol-migration.md#92-order-of-plugins) item 7).

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
([§9.4](../history/plugin-hostapi-protocol-migration.md#94-the-wire-step-implementation-plan)), so no JS plugin sees the change.

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
directory above `<AVE_HOME>`; [§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan) A2). srt-win's PowerShell inner shell, its default, is
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

- `emitEvent` delivers only to the bound plugin’s own UI. Another plugin’s
  events cannot be emitted or subscribed to through HostApi.

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
`ave/host/storage/read`, and `config.set` is `ave/host/config/set`.
The lifecycle methods keep `ave/instance/*` (`plugin-instance-wire.ts:38-45`):
`construct`, `start`, `onPublished` and `stop` remain; `readUiResource` folds into
MCP `resources/read` (§5). Shutdown uses stdin EOF rather than a protocol method.
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
  boundary promises instead is the deprecation shape of [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path): the boundary is announced
  at least one minor release ahead, **tested candidate** replacements for every official
  plugin exist before the boundary is tagged and **published** replacements before the
  app draft is published ([§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path), [§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19)), and an artifact that does not declare a served
  version is refused **before factory activation** with `incompatible-host-protocol`
  and an update path — on both loader arms, for every install source, offline included.
  Reason 4 (independent release) is kept by the *additive* rule of §3.3 — which is what
  a plugin built against `1` actually relies on between boundaries — not by dual-serving.
  The first boundary is the Lease step: `L = 2`, `X` = **0.12.0**, the minor after
  v0.11.0 (decision 8; matrix and cost in §6.4, sequence in [§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19)).
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
  how optional members (`hostFetch?`, `spawnWorker?`, `resolveApiKey?`) are
  expressed without `undefined` checks.
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
that protocol 3 accepted now fails. Under §3.2 and §3.3 this was **protocol 4**,
not an optional capability on 3; protocol 5 (§3.3.2) carries it unchanged. A capability list names methods and does not
select different state semantics for the same method. No state-free branch or
compatibility shim is served. An unreleased protocol has no numeric app-version
floor; negotiation of `requires.hostProtocol` is authoritative. Candidate schema
version segments do not imply released support. Release preparation records the
first published app version when the protocol ships.
The 2026-10-27 owner decision authorizes preparing this boundary now; it does not declare replacement plugin packages published.
The replacement testing and publication gates in [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path) and [§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19) still apply before
an app release is published: test candidates against the boundary commit, vendor
the contract from its app release tag, and publish replacement plugin packages
before publishing the app draft. See the [author migration and PKCE example](../guides/plugin-development.md#loopback-oauth-with-pkce).

### 3.3.2 Worker stdio control v1

A worker that `spawnWorker` starts talks to its plugin only over its own stdin,
stdout and stderr. No platform allocates a socket, a port or a loopback address
for it, and the spec has no `udsArgName`. Each spec names one `control` mode; a
missing or unknown mode is refused before anything is created:

- `"output-only-v1"`: stdout and stderr are text, delivered to `onStdout` and
  `onStderr`. stdin is never written; its EOF is the liveness signal.
- `"stdio-control-v1"`: stdout carries frames only and stderr carries the
  worker's diagnostics. The handle offers `request`, `notify`, `onRequest` and
  `onNotification` instead of `onStdout`.

A frame is one line of UTF-8 JSON-RPC 2.0, at most 16 MiB
(`WORKER_CONTROL_FRAME_BYTES_MAX`) before its newline. The host's first frame is
the request `$/ave/hello` with id `0` and params
`{ protocol: "ave-worker-stdio-control", versions: ["1"], frameBytesMax }`. The
worker's first frame must answer it with
`{ protocol: "ave-worker-stdio-control", version: "1" }`. `spawnWorker` resolves
only after that answer. A worker that answers wrongly, writes anything else first
or does not answer within `TOOL_TIMEOUT_POLICY.workerControlHelloMs` is stopped,
its exit is awaited, and the call rejects with `worker-control-failed`.

After the hello, either side may send requests and notifications. Method names
match `^[a-zA-Z_][a-zA-Z0-9_]{0,127}$`; names under `$/` are the host's.
`$/ave/cancel { id }` withdraws a request in either direction; the receiver still
answers it, and a cancelled request counts toward the limit until that answer
arrives. `$/ave/shutdown` precedes an orderly stop, after which the host closes
stdin; a worker must exit on stdin EOF in either case. If the shutdown frame cannot
be queued because the worker stopped reading, the host goes straight to EOF and
termination.

Bounds, each enforced by the host:

- Host to worker: at most 64 outstanding requests; the 65th is refused to the
  plugin with `worker-backpressure` and the worker keeps running.
- Worker to host: at most 64 outstanding requests; the 65th is a
  `control-violation` and stops the worker.
- At most two frames' worth of bytes (2 × (16 MiB + 1)) queued toward the worker's
  stdin. A new plugin request or notification past it is refused with
  `worker-backpressure`; a response or cancel the host owes a worker that has
  stopped reading ends the incarnation as a `control-violation`.
- At most 256 worker notifications, and 2 × (16 MiB + 1) bytes of unclaimed worker
  requests and notifications, wait for the plugin's handler or first listener;
  beyond either the worker stops with `output-overflow`.
- Toward a plugin child, the relay stops reading the worker's stdout and stderr
  whenever the child's wire must drain, whatever filled it, and resumes once it has,
  so a worker that writes faster than its plugin reads blocks on its own pipe. The
  wire's own queue bound covers the channel as a whole. The relay bounds only what
  this worker pushed since the wire last drained, counted in UTF-8 bytes where each
  frame is serialized: past 2 × (16 MiB + 1) bytes the
  incarnation ends with `output-overflow`. A handle the host cannot pace (one it did
  not produce itself) is stopped instead, with reason `stopped`.

A listener the plugin registered that throws is logged; it never surfaces as an
uncaught exception in the host. The worker is stopped, with the exit reason named,
when it breaks these rules:

| Exit `reason` | Cause |
| --- | --- |
| `exited` | the worker exited by itself |
| `stopped` | the plugin or the host stopped it |
| `control-violation` | a line that is not a frame, a malformed frame, a reserved or invalid method, a duplicate or unknown id |
| `output-overflow` | an output-only worker filled the pre-listener buffer, too many notifications or bytes waited for the plugin, or the worker pushed more than the relay bound toward a child that had not drained |

Pending calls of an incarnation that ends reject with `worker-incarnation-ended`.
Nothing is replayed: the host ends the incarnation and the plugin decides whether
to start another one. A worker that needs network access asks its plugin over this
channel, and the plugin performs the call with `hostFetch` under its own
declarations; the worker holds no keys and opens no listener.

Control traffic between the plugin process and the host crosses the plugin
session as the child notification `notifications/ave/subscription/send`
(`{ subscriptionId, payload }`), scoped to the worker's handle. The host answers
with the worker's subscription events: `result`, `error`, `request`,
`notification`, `cancel`, and `exit` with its reason. A malformed send still settles
what it names: a request or notification gets an `error` event for its id, and a
response settles the worker request it answers with an error. A send whose id cannot
be read revokes the handle, and the child settles every call on it. A send that races
the handle's close is dropped. These frames are not new
`ave/host/*` methods and pass no effect gate of their own: the effect boundary
decided `spawnWorker` once, and the handle carries no authority beyond the worker it
names.

`stateDirectory: true` asks the host for `~/.ave/plugins/<id>/workers/<workerId>/`,
created with mode `0700`, granted read and write to that worker only and named in
its `AVE_WORKER_STATE_DIR`. It is a sibling of the plugin's `data/` directory, so
the plugin process itself holds no write grant on it. A spec may not set
`AVE_WORKER_STATE_DIR` itself. The frame schema is published as
`schemas/worker-stdio-control/1/worker-control.schema.json`.

### 3.4 Streaming and notifications

Everything that outlives its reply becomes a subscription with a host-allocated id and a
two-sided lifetime; this is the shipped `SubscriptionLedger` mechanism
(`subscription-ledger.ts:5-28`) given JSON-RPC names.

| Direction | Message | Purpose |
|---|---|---|
| plugin→host request | `ave/host/onEvent`, `config/onChange`, `startAudioCapture`, `spawnWorker`, `attachFloatingPanel`, `resolveApiKey` | returns `{ subscriptionId }` (or a handle carrying one) |
| host→plugin notification | `notifications/ave/subscription` `{ subscriptionId, payload }` | one event, one frame, one worker chunk, one config change |
| host→plugin notification | `notifications/ave/subscription/closed` `{ subscriptionId, reason: "revoked" }` | host ended it (plugin retired, dock slot detached, capture surface lost) |
| plugin→host notification | `notifications/ave/subscription/release` `{ subscriptionId }` | plugin called its disposer |
| host→plugin notification | `notifications/ave/config/snapshot` | child-local cleartext config snapshot |
| either direction | `notifications/cancelled` | replaces `kind: "abort"` (`host-api-wire.ts:131-135`; §3.5) |

These rows cover the host notification contract. A frame the router does not
recognise is dropped ([§9.4](../history/plugin-hostapi-protocol-migration.md#94-the-wire-step-implementation-plan) item 4). `peer-gone` is never sent; it
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
row `config.get`).

Progress: long host operations (`callLlm`, `spawnWorker` startup) may carry an MCP
`progressToken` in `_meta` and emit `notifications/progress`
([MCP progress](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/progress)).
Optional, not required in protocol `1`.

Plugins write diagnostics to stderr. The host attributes each buffered line with a
structured `pluginId`, redacts free text, caps retained line content at 16,384
bytes with a truncation marker, and captures ordinary lines at info level.
Leading `WARN ` or `ERROR ` tokens raise the level. A shared per-plugin bucket
allows 100 lines per second with a burst of 500; excess lines produce one
aggregated summary without terminating the plugin. Stdout remains exclusively the JSON-RPC stream.
The host closes stdin on shutdown, waits the existing grace period, then escalates
through SIGTERM and SIGKILL if the child has not exited. Plugins release resources
on stdin EOF; there is no shutdown callback registration.

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
direction's pending table is dropped, like any unrecognised frame ([§9.4](../history/plugin-hostapi-protocol-migration.md#94-the-wire-step-implementation-plan) item 4). MCP
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
| `emitEvent` | notif | plain-json → void | bound plugin’s own UI only; another namespace is refused | no cross-plugin delivery |
| `onEvent` | sub | handler-registration | host theme updates only | notification stream |
| `getSecret` (:1339 at `f1a8d191e`) | req | plain-json → plain-json | four-tier `runSecretGate` (`src/plugins/secret-access/secret-gate.ts:190-215`); host-key entitlement and provenance (`grants.ts:33-44`, `:87-111`); **value crosses**, by design: an allow-listed secret is granted to this plugin | audit unchanged. Under Lease the shared gate gains an operation axis: `getSecret` is `export`, refused for the host-provider key class for every plugin before the read; the entitlement rows stay for the resolver's `lease` operation (§4.1.6); own-namespace reads stay. See §4.1 |
| `resolveApiKey` (:1350 at `f1a8d191e`) | sub | encoded → `WireApiKeyLease` handle (`host-api-wire.ts:2003-2015`), child-disposable | gate + permission revoke signal (`host-api-factory.ts:794-827`); lease registry and epoch fencing (§4.1.2) | **raw key stops crossing** on the default `exposure: "lease"`; `bearer()` removed from the contract; `key` crosses only for `exposure: "raw"` under `secrets:raw-api-key` (§4.1.1) |
| `callLlm` (:1349) | req | encoded → plain-json | host provider, host rate window, `effect-boundary-denied` | cancellation via `notifications/cancelled` |
| `hostFetch` (:1402 at `f1a8d191e`) | req | encoded → encoded | Tier A egress gate, allow-list, SSRF (`host-fetch-guard.ts:9-20`); partition cookies attached host-side (`host-api-factory.ts:1056-1085`); per-hop recheck (`host-fetch-guard.ts:438-485`) | bodies buffered and capped at 16 MiB; gains `init.auth = { lease }` (§4.1.1) with host-owned credential injection, audience and redirect rules (§4.1.3-4.1.4); `FormData` bodies serialised by the reference runtime (§8) |
| `raiseAlert` (:1886 at `f1a8d191e`) | req | plain-json → plain-json | manifest `alerts.kinds`; alert service rate limit returns `status: "rate_limited"` as a *result* (`src/alerts/service.ts:338-339`, `:357-358`), distinct from the transport `rate-limited` error (§3.6) | unchanged; golden fixture `fixtures/host-protocol/1/methods/ave/host/raiseAlert.json` |
| `spawnWorker` (:1410) | sub | plain-json → handle | worker envelope must be within the plugin's envelope (`host-api-dispatcher.ts:1160-1161`); command is a host-spawned process | `{ handleId, control, pid }` cross; control traffic is the child notification `notifications/ave/subscription/send` (§3.3.2); the internal handle id derives from the existing RPC id and is registered before send; stdout/stderr/exit notifications use bounded pre-listener replay, drained-output completion and explicit overflow failure as defined in the blueprint §3.2 (`host-api-wire.ts:1652-1666`) |
| `openAuthWindow` (:1437) | UI | plain-json → plain-json | host-owned BrowserWindow, cookie host allow-list (`auth-window-service.ts:10-16`) | with `retainCookies` the values stay in the partition; the reply carries names or the final URL only |
| `authRedirect.open/wait/close` (:1474-1484) | req | plain-json | host loopback listener, one per plugin | host-issued state required before callback delivery (§3.3.1) |
| `pickFolders` (:1510) | UI | plain-json | OS dialog, user consent is the dialog | unchanged; the chosen paths do not widen the envelope unless declared (§2.2) |
| `resolveMappedDriveRoot` (:1530) | req | plain-json | host replaces a `powershell.exe` spawn (blueprint §10) | unchanged |
| `listAudioInputDevices` (:1536) | req | plain-json | renderer permission state | unchanged |
| `startAudioCapture` (:1551) | sub | plain-json → handle | host-owned renderer capture (`audio-capture.ts:4-14`); microphone/system permission is the OS prompt | frames as notifications (§3.4, §8) |
| `attachFloatingPanel` | sub | plain-json → handle | one host-owned dock, height clamped (`floating-dock.ts`) | `detached` notification |
| `openAuthPartitionViewer` (:1632) | UI | plain-json → void | partition owned by the caller; URL host in `auth.partitionDomains` (`auth-partition-viewer-service.ts:15-19`) | unchanged |
| `clearAuthPartition` (:1660) | req | plain-json → void | partition name must be the caller's | unchanged |
| `getAuthPartitionCookies` (:1685) | req | plain-json | gated read; **values cross** (`public-contract.ts:195-202`) | see §4.1: stays, but is the one member that hands a session credential to the plugin |
| `openExternalUrl` (:1713) | UI | plain-json → void | host webView preference policy | unchanged |
| `probePrivateHost` (:1742) | req | plain-json | host resolver; result is a boolean | unchanged |
| `triggerConversation` (:1785) | req | plain-json | overlay staging only; a user click starts the turn (`:1765-1767`) | unchanged |
| `hasRoutineBySource` (:1801) | req | plain-json | none | unchanged |

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
  In-process (while that arm exists, [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)) the same registry issues the same ids; the
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
  are replaced by the vendored `ApiKeyLease` type when those plugins are rebuilt ([§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps));
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
  committed getter to bind to. **Acceptance (slice D, [§9.6](../history/plugin-hostapi-protocol-migration.md#96-host-pr-slicing-and-gates-for-the-lease-step-decision-23))** drives the real
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
and the acceptance tests of [§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps) assert its absence in every official caller.

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
| `git` (`d71fb95`) | in process; direct `fetch` with cookie and GitHub auth (`src/hostPlugin.ts:797-806`) and with plugin LLM keys (`:920-932`); `~` expansion of `dataDirectory` (`:824-834`) written under (`:1140`) | rebuilt and republished for `hostProtocol: "2"` under the generic rule (the 0.12.0 wave; `"3"` since 0.14.0); the direct-fetch and external-directory migrations are Admission prerequisites ([§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps), [§9.2](../history/plugin-hostapi-protocol-migration.md#92-order-of-plugins) item 7), not Lease work |
| `assistant`, `hello-world`, `templates/plugin` | no credential surface | republished for `hostProtocol: "2"` (the 0.12.0 wave; `"3"` since 0.14.0; assistant only if it is not already revoked by the alerts release, [§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19)) |

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

While the in-process arm exists ([§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)) the factory receives live plugin objects. It
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
stock MCP server library ([§9.4](../history/plugin-hostapi-protocol-migration.md#94-the-wire-step-implementation-plan) item 5).

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
  tree at the final version** — slice E of [§9.6](../history/plugin-hostapi-protocol-migration.md#96-host-pr-slicing-and-gates-for-the-lease-step-decision-23) owns this — and the v0.11.0 release
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
  [§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19) imposes; regenerating the candidate is permitted **only while no tag carries its
  bytes** — once the tag exists the canonical file is frozen on `main` until the next
  version bump opens the next candidate, whatever `publishedTag` says, and that bump is
  the first change after the tag (`docs/development/release-process.md`, "Between
  releases"; [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan), "The mirror freeze") — so a protocol change that must ship after the
  freeze ships as the next candidate. **(E2, the post-publication runbook step)** the `web`-only PR merged after
  the app draft is published ([§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19) step 6) sets the entry's `publishedTag` and, in the
  same commit, sets the protocol's `alias` to the **newest published copy of that
  protocol** — the promoted copy if it is the newest, otherwise the alias stays where it
  is — which is the explicit promotion mechanism; a candidate's copy cannot become the
  alias by deploying. The check enforces the newest-published rule whether or not the
  protocol has an open candidate, so two promotions of one protocol commute in either
  order (`scripts/lib/plugin-host-protocol-mirror.mjs`; [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) M1, decision 39). The v0.11.0 release does
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
| Protocol-level TS client (JSON-RPC stubs) | host build | the committed protocol schema ([§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) P1) | `schemas/plugin-host-protocol/<version>/protocol-client.ts`, emitted beside the schema, dependency-free, carrying the protocol version and no app version, gated by `check:plugin-host-protocol-client` and vendored with the schema; used by the conformance tests and by authors who want to speak the protocol from JS without the reference runtime |
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
only after tag X exists ([§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19)): a candidate-ref sync is development evidence and
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
second reason it cannot be admitted on X. **Gates that hold X (one timeline, [§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19)):**
*before the tag* — the boundary is announced in the v0.11.0 release notes and on the
marketplace announcement channel (marketplace design §11) no less than fourteen days
before X is tagged, and **tested candidate** artifacts of every replacement have passed
the plugin acceptance of [§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps) against a packaged candidate app; *before the app draft
is published* — every replacement has been re-vendored from tag X and **published** as
an immutable artifact, and the plugin-status refusal and its update path have been
exercised in the packaged upgrade matrix against those published artifacts. Final
artifacts cannot precede the tag they are vendored from, so "published before the tag"
is never a requirement. **Applicability:** the replacement set is every code plugin
that is published and not revoked at X — `meeting`, `local-indexer`, `mail`,
`hello-world`, `portal`, `git`; `assistant` only if the alerts release has not
revoked it ([§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19)); `templates/plugin` is not a published artifact and is instead
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
  (`out-of-process-plugin.ts:1397`). No protocol method bypasses a gate.
  Extensions cannot issue separate approval requests.
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
| RPC surface abuse: a plugin hammers `ave/host/*` (log flood, storage churn, `triggerConversation` spam, subscription leak) | per-(plugin, method) token bucket in the dispatcher with a refusal code `rate-limited` (new, added to the closed set); cap on open subscriptions per plugin; the numbers are §7.4. `WIRE_BYTES_MAX` 16 MiB per decoded payload (`host-api-wire.ts:709`, `:810-815` at `f1a8d191e`), and a per-line cap in the frame decoder derived from it, whose overrun terminates the child (added with the newline framing, [§9.4](../history/plugin-hostapi-protocol-migration.md#94-the-wire-step-implementation-plan) item 1), so a child that never writes a newline cannot grow the host's buffer without bound. Plain-JSON values (tool results, `storage.readText`/`readJson` replies, arguments) have no payload cap of their own, so each side checks the frame against the same cap before it writes: an oversized reply becomes a `payload-too-large` error for the same id, and an oversized request rejects its caller with `payload-too-large`. The receiver's kill is reserved for a peer that skipped that check; stderr diagnostics have their independent line and rate bounds (§3.4). |
| Resource exhaustion: a plugin process consumes memory/CPU | Linux: per-plugin cgroup limits are not wired to the spawn path. macOS: `RLIMIT` in the wrapper is deferred (decision 7); Windows: Job Objects are not available through srt-win today. Until then the control is crash containment: the host survives, the plugin is marked degraded. |
| A plugin process outlives the host | child exits on stdin end (`plugin-child-main.ts:319-326`); `managed-child-processes.ts` tracks and kills process groups on app quit; a `process`-entry plugin must pass the stdin-close conformance check (§10). Residual: a hard host crash on Windows leaves the child to notice a closed pipe on its next write. |
| Arbitrary executable via `process` entry | a pinned release or archive artifact only (§2.1); a wrap whose published `confines` includes `process` (never srt-win); refused when the sandbox is off; the command must be inside the plugin root (Agent Plugins rule); no `PATH` search for a marketplace plugin. |
| Envelope widening via the manifest `sandbox` block | closed `hostDirectory` allow-list; `userChosenDirectory` requires a user-set absolute path; deny-floor piercing requires install-time approval (§2.2). |
| Windows: no process confinement | unchanged from `architecture.md:1018-1020`; admission does not depend on it (decision 3); a `process` entry is refused on Windows because srt-win is a wrap that does not confine processes (§2.2); the Doctor names the confinement each plugin runs under. |
| Windows: one sandbox identity for every plugin | none by design (decision 64): every confined process — each plugin's child, workers, and the host's own tools — runs as the one `srt-sandbox` account, so a plugin child's or worker's grant is visible to every confined process while held (measured: two grants held at once, each plugin read and wrote the other's data) and no deny can separate plugins; `denyPluginsRoot` is refused there. Inter-plugin isolation is a macOS and Linux property only ([§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan) A2). |
| Confused deputy through the host's own credentials | `hostFetch` attaches a lease only to a URL that is inside the lease's host-derived **audience** (§4.1.3) *and* passes the plugin's own allow-list; the allow-list alone is not enough, because it says where the plugin may send its traffic, not where the host's key may go. The lease id is per plugin incarnation and is `lease-unavailable` on any other connection; every host-injected credential header is cleared on an origin change and re-authorised per hop, including Azure `api-key` (§4.1.3); a caller cannot supply a credential header on a leased request (§4.1.4). Matches the MCP security guidance on token passthrough ([MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)). |
| A lease outlives the decision that granted it | the host registry ends it on permission revocation, secret rotation, vendor or endpoint change, plugin update/disable/uninstall and incarnation end, with epoch fencing after every await and abort of active uses (§4.1.2). Request cancellation is a separate mechanism and never stands in for it. |
| A raw grant is inferred from an old manifest string | raw issuance requires the reviewed authority and the reviewing app version ≥ X in the receipt, plus the unchanged provenance evaluator (§4.1.6). |

### 7.4 Dispatcher budgets (decision 20)

Budgets live in the dispatcher (`HostApiDispatcher`), so they apply to the child arm;
the in-process arm's direct callers are **not** budgeted, which is one more reason its
removal condition ([§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)) matters and is stated rather than hidden. Service-level limits
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
| `emitEvent` (notification) | 50/s, burst 200 | plugin id | dropped, counted; one audit line per 60 s |
| child stderr | 100 lines/s, burst 500 | plugin id | excess lines dropped with one summary; child stays alive |
| in-flight requests | 64 | plugin incarnation | `rate-limited`, `retryAfterMs` 100 |
| open subscriptions, total | 256 | plugin incarnation | `rate-limited` on the opening request |
| per kind | `onEvent` 64, `config.onChange` 16, `spawnWorker` 8, `startAudioCapture` 2, `attachFloatingPanel` 1, leases 32 (§4.1.2, its own `lease-limit` result) | plugin incarnation | same |

Rules: buckets are keyed by plugin id and survive handle churn, so opening and
releasing handles cannot reset a quota; a restart is a host action and starts a new
incarnation with fresh buckets. The registration cap counts leases and raw
registrations together and is owned by the one host-level lease registry (§4.1.2),
which both loader arms share, so the in-process arm is inside *this* cap even though it
is outside the dispatcher's request buckets. Exempt from every budget, so that cleanup
works under saturation: `notifications/ave/subscription/release`,
`notifications/cancelled`, replies to `ave/instance/stop`, and a lease `release()`. Memory: each in-flight entry and
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
host→plugin direction and are not budgeted here. The acceptance evidence of [§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps)
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
  install goes out of process ([§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps)).
  Plugins start in parallel, and the loopback projection is unchanged, so the user-visible
  cost is the slowest plugin, not the sum.
- **Per-call latency.** One JSON round trip per hostApi call. Members on hot paths
  (`config.get`, `storage.resolve`) are child-local already; `emitEvent` is a
  notification and never waits. Diagnostics go to stderr.

---

## 9. Migration

The completed migration plan is archived in [migration history](../history/plugin-hostapi-protocol-migration.md#9-migration).

## 10. Validation strategy

### 10.1 Conformance tests (host repo)

1. **Schema ↔ dispatcher parity.** Every `HostApiPath` has a schema entry, every schema
   method has a handler, every error code in the schema is in the closed set. Modelled on
   `hostapi-effect-completeness.test.ts` (walks the real object) and
   `hostapi-serialization-conformance.test.ts` (every member is JSON-representable or
   owes a decision, `:1-20`).
2. **Golden fixtures.** One JSON request/response pair per method and per error code,
   replayed over in-memory paired streams against the real child runtime. Until [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) S1
   that is the in-memory substitution `out-of-process-plugin.test.ts:1-10` describes,
   made through the factory's `connect` member;
   from S1 the streams attach to the validation-only session entry
   (`openValidationSession`), and the production factory has no substitution point —
   only the observation-only `observeChild`, which sees the production child after the
   wrap and cannot replace it.
3. **Real confined child.** `confined-plugin-child.test.ts` keeps proving the
   confinement half with a real process (`out-of-process-plugin.test.ts:12-16`), on macOS
   and (from [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) P3) Linux; it gains the stdin-close-exits check without a termination
   call and the stdout-discipline check on the raw bytes, not on decoded frames.
4. **Adversarial fixture** (admission step): read `~/.ave/secrets/`, direct egress,
   `require("electron")`, monkey-patch a host internal, name another plugin's id, replay a
   lease id on another connection — each denied.
5. **Cross-language smoke**: a minimal Python plugin using a stock MCP server library for
   tools and a JSON-RPC library (or the generated client) for `ave/host/*` and
   `ave/instance/*` on the same stream passes 1-3.

### 10.2 Test support

The scripted host and session helpers live under
`src/__tests__/support/plugin-validation/` and serve protocol conformance tests.
The app enforces manifest and protocol admission during installation and loading.

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
   after the warning starts or an explicit version boundary". [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path) uses the same shape,
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
4. **MCP unchanged for everything**: model `callLlm` as sampling, `pickFolders`
   as elicitation, storage as resources, secrets as OAuth. In
   `2026-07-28` sampling and elicitation are `InputRequiredResult` answers to a client
   request, not server-initiated calls, so a plugin could ask for anything only while
   answering a tool call. Loses host
   semantics (rate window, key gate, OS dialogs, the permission gate), forces a bespoke
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
| 1 | The plugin channel is newline-delimited, per the MCP `2026-07-28` stdio binding ("newline-delimited JSON-RPC over a byte stream", [MCP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)). | An off-the-shelf MCP server library frames that way, and the host's external MCP client already does (`mcp-client.ts:2365-2368`, since `97b400ecf`). The host decoder and the reference runtime switch together ([§9.4](../history/plugin-hostapi-protocol-migration.md#94-the-wire-step-implementation-plan)), so no installed plugin sees it. |
| 2 | `resolveApiKey` stops exporting the raw key on its default path: `bearer()` leaves the contract, the default result is an opaque `ApiKeyLease`, `hostFetch` gains `init.auth = { lease }`, and a host provider key crosses **through `resolveApiKey`** only under `capabilities: ["secrets:raw-api-key"]` with receipt-bound consent (§4.1.1, §4.1.6). The guarantee is scoped to `resolveApiKey`; own-namespace `getSecret`, `portal`'s partition-cookie export and `readEncrypted` plaintext are the inventoried exceptions (§4.1). | The credential attaches at the egress chokepoint the way partition cookies already do; the capability makes the exception visible to the user and countable by the host. Neither official consumer needs it: `meeting`'s STT egress goes through `hostFetch`, and `local-indexer`'s worker traffic already reaches `hostFetch` through its JS broker, which gains lease attachment (decision 10). The earlier text that said `local-indexer` "forwards the bearer itself" was stale at `6a4d3b3`. |
| 3 | Out-of-process admission is decided the same way on every platform and for every install source — official, managed, custom, direct, local development, and origin-less legacy entries (`legacy-plugins.ts:90-93`). A code plugin loads out of process under the confinement the host chose for its workers: `features.pluginWorkerConfinement` (`features.osToolSandbox` until the 0.14.1 split; that setting now covers host shells only), off by default on every platform (`sandbox-gate.ts:20-21`); while it is off the child is spawned unwrapped (`out-of-process-plugin.ts:13-21`). What admission promises is the process boundary — separate heap, no Electron, own crash domain, one structural chokepoint — not OS confinement; OS confinement is whatever the substrate publishes (`architecture.md:1017-1020`): filesystem, process and network on macOS and Linux, filesystem and network on Windows. Only a non-JS `process` entry requires a wrap whose `confines` includes `process`, so it never loads on Windows and does not load anywhere with the sandbox off (§2.2). The Doctor's plugin report names, per plugin, the confinement it runs under. | An earlier draft refused custom and direct code plugins on Windows and admitted official and managed ones. Rejected on evidence: `origin.sourceOrigin` alone is not evidence, because the registry file is user-writable and `src/plugins/registry.ts:300-311` checks only shape, legacy migration binds `official` by plugin id with `artifactSha256: null` (`legacy-plugins.ts:95-124`), and a removed `additional` source leaves `managed` behind, so a sound version would need the host-secret evidence chain (`grants.ts:87-106`); it would grant the official and managed sources a privilege the marketplace design forbids (§10: the badge is the only thing the official source grants; §10.5); it would refuse `portal` and `git` on Windows, since neither is in the official index (`marketplace.json` at `6a4d3b3df` lists `hello-world`, `local-indexer`, `meeting`, `mail`, `assistant`) while `portal` already runs out of process there (`out-of-process-plugins.ts:857`); and its rationale was false by default on every platform, because with the sandbox off macOS and Linux run a custom plugin without process confinement too. |
| 4 | A non-JS `process` entry is in the manifest schema from protocol `1` (`schemas/plugin-manifest.schema.json:1121`). Its runtime and a **narrow** marketplace admission — a sha256-pinned `release` or `archive` artifact recorded in the receipt, a live sandbox whose `confines` includes processes, never Windows, `minAppVersion ≥ 0.13.0` — ship in Publication (0.13.0, [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) P3-P4). Out-of-process-by-default admission for every install and the adversarial fixture stay in the Admission step. | The protocol is language-neutral from its first published version. The earlier wording deferred all marketplace admission for `process` to the Admission step, which contradicts the Publication scope ([§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps), §2.1's pinned-artifact rule); what the adversarial fixture must precede is admission of unpinned or unconfined code, and that stays refused on every path (decision 35). |
| 5 | The deprecation owner of the in-process loader is the organization owner role of `former_org` (the repository's sole maintainer) — a role, recorded as such in `TODO.md` when the wire step starts; ave has no `CODEOWNERS` file. | AGENTS.md requires a named owner and a removal condition for any coexistence ([§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)). |
| 6 | The protocol schema is canonical in the ave tree at a release tag and vendored like the rest of the contract (§6.3); its `$id` carries the app tag; ave.agent-connector.ai mirrors every copy `mirror.json` records from `web/public/schemas/` (published, candidate or orphan, each frozen against its own hash, §6.1), with `/1/protocol.schema.json` as a documented moving alias for editors. The validate CLI is a `tools/vendor/` bundle built from an ave entry (§10.2). | A release tag plus a sha256 in `contract/sources.json` is what the contract already pins; `tools/vendor.mjs` already holds bundles built from ave entries with a recorded bun version (`vendor.mjs:5-11`); release assets would be a second publication of the same bytes. The tag in `$id` is what keeps an additive revision (§3.3) from changing the bytes behind one identifier, since the site deploys on every `web/**` merge, not on tags. |
| 7 | Per-plugin resource limits on macOS are deferred: crash containment ships first, and the conformance suite records RSS and startup time per plugin. | No number exists to size an `RLIMIT` against. |
| 8 | **Release target (owner, 2026-09-27).** Lease ships in **0.12.0** (X). v0.11.0 ships first with its current scope (wire and alerts). Official plugins publish their alerts versions first and bump again for Lease, with no combined bump; a published artifact is never rewritten ([§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19)). | Lease is a protocol boundary with its own notice, replacement and matrix gates; folding it into a release whose scope is already fixed would either skip those gates or reopen that release. The version number itself is not the gate. |
| 9 | **Installed-plugin cutover (owner).** Announced hard cutoff with pre-activation refusal: X serves protocol `2` only; a code plugin whose manifest does not declare a served `requires.hostProtocol` — including one that declares nothing — is refused before factory activation on both loader arms and for every install source, with a clear status and an update path. The rule is generic, never keyed to a plugin id or a method heuristic; `minAppVersion` is never an upper bound. §3.2's retention promise is rewritten; the cost, the notice and replacement gates and the old/new matrix with downgrade are in §6.4 and [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path) ([§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19) for the sequence). | Retaining `1` would mean a second frozen runtime, schema set, codec, child stub and envelope policy, which the generator (`plugin-host-protocol-schema.ts:317-324`) and the single bound dispatch table (`out-of-process-plugin.ts:1423-1444`) cannot express by adding an array element; a version label that does not select an implementation is not compatibility. Omission cannot keep meaning "newest" on X because the newest is incompatible with the bearer the old bundle calls (`host-api-child.ts:342-394`; `meeting` `plugins/meeting/source/src/hostPlugin.ts:1911`). Postponing X when the gates are unmet is what protects users; a runtime fallback would hide the break. |
| 10 | **local-indexer path (owner).** The existing JS egress broker in the plugin child gains host lease attachment: broker → `hostFetch` with `auth.lease`, one lease per upstream request, acquired before the relay and released in `finally` after the buffered response body completes, the worker's abort linked to the use's signal. Plugin-owned-key mode stays. The lease-mode host-key `getSecret` fallback and the bearer-length availability check are removed from the plugin; host-side the same read is refused by the gate's `export` rule (decision 17), not by deleting entitlement rows (§4.1.6-4.1.7). No raw exception exists because a Python SDK is present. | The worker never held the shared key on the production path (`workerClient.ts:472-474`, `embedding_client.py:159-167`); the only raw reach is the JS channel callback. A maintained per-channel lease needs refresh/revoke state and would let query-time search reuse a stale scan handle; per-request is one resolve and one release notification per call, priced in §7.4 and revisited only on measurement. |
| 11 | **Sandbox location (owner).** `extensions["ai.agent-connector.ave"].sandbox`, a sibling of `requires`, `capabilities`, `networkAccess` and `alerts`; carried through the descriptor and index with equality checks, the install review and upgrade deltas, the receipt, and the official repository's checker, re-vendored. `ceilingSubtractions` keeps subtracting the closed host catalog globally; a missing declaration gets only the base envelope (§2.2). | Authority is what the marketplace pins, reviews and holds equal; a block outside the extension object would be invisible to that pipeline, and a block nested under `requires` or `capabilities` would change the meaning of two closed objects. |
| 12 | **Lease shape.** `ResolveApiKeyResult = ({ ok: true } & ApiKeyLease) \| ({ ok: true } & ApiKeyRaw) \| ResolveApiKeyDenied`; `leaseId` = wire `handleId` = subscription id, one opaque host-minted string (`lease_`/`raw_` prefixes); `release()` is an idempotent one-way notification that aborts active uses and never throws; `onClosed` accepts any number of listeners and replays to a late one; the reference runtime parks a `closed` that precedes adoption; the result axis becomes `handle-or-denied`; raw returns `key` bytes and says they cannot be recalled; `HostFetchInit.auth = { lease }` exactly, **forwarded by the dispatcher to the factory's single `hostFetch`**, turned into a credential-use context there, and absent from the transport init (§4.1.1). | One identifier removes a mapping table and lets the existing subscription release/closed notifications carry the lifetime. Stripping in the dispatcher would leave the in-process arm on a different enforcement path; the factory is the only place both arms meet. A `bearer()` thunk on the raw branch would pretend to revoke copied bytes. |
| 13 | **Lifetime.** `issuing → active → released \| revoked`, `peer-gone` only at incarnation or connection end; no wall-clock expiry; the record carries incarnation, permission epoch, secret generation and provider-configuration revision, and every use re-checks all four after each await; revocation on permission revoke, secret write/rotation/removal/withholding, active-vendor/endpoint/preset change, plugin update/disable/uninstall; active uses aborted, bytes already sent not recalled; `opts.signal` cancels the resolve request only; ≤ 32 registrations per incarnation, reserved at entry (§4.1.2). | Event-bound lifetime has no race a timer would fix; today nothing closes an issued ledger entry on any of these events (`host-api-dispatcher.ts:795-832` opens it, `host-api-factory.ts:813-816` only passes the revoke accessor into the resolver), and one host registry owned by the plugin-runtime step is the code path both arms share. |
| 14 | **Audience and scheme.** Keyed by the host's normalized source record, not the request union: `openai` → `Bearer`, `azure-foundry` → `api-key`, `claude` → `x-api-key`, each at the origin the host's own adapter uses (configured base URL, else the public default; Azure with no base URL is `endpoint-unavailable`); `gemini` and `vertex-ai` are `vendor-unsupported` for lease in 0.12.0 (Vertex authenticates with ADC, not a stored token); plugin-own keys → the plugin's allow-list. Origin match, `https` only, no path binding; empty intersection with the allow-list denies at resolve. Lease mode keeps the guard's independently approved loopback/private exceptions and adds no network rule of its own. Per hop: clear the closed `CREDENTIAL_HEADERS` (`authorization`, `proxy-authorization`, `cookie`, `api-key`, `x-api-key`, `ocp-apim-subscription-key`) on any origin change, re-check liveness, re-inject only inside the audience, otherwise refuse the redirect (§4.1.3). | The plugin's allow-list authorises the plugin's traffic, not the host's key; the current three-header strip (`host-fetch-guard.ts:475-478`) lets an `api-key` cross origins, reproduced by the cross-review. Relabelling a stored Vertex string as a token, or refusing every private target the guard already admits for the corporate Azure case, would each be a false claim about the host. A silent unauthenticated downgrade on redirect would turn an audience violation into a confusing provider error. |
| 15 | **Conflicts.** No lease: caller headers pass, so `mail` OAuth, `portal` cookies, plugin-key modes and the FFmpeg download keep working, and a non-vault caller `Cookie` still passes. Lease: any caller credential header, **`Cookie` included, vault-declaring or not**, is `credential-conflict`; a malformed `auth` is `credential-conflict` at every layer. Lease + host-injected partition cookie: allowed only when both grants independently cover the URL; cookie prepared, liveness re-checked, then injected (§4.1.4, full matrix there). | A blanket `Authorization` ban breaks valid non-lease callers; two reviewed grants for one URL are a stronger statement than a prohibition; leaving the non-vault caller-Cookie cell undecided would let a plugin pair its own session with the host's key. |
| 16 | **Errors.** Four thrown codes join the closed set: `lease-unavailable` (one code for unknown, foreign, raw, released, revoked and stale-epoch, no oracle; never raised by `release()`), `lease-audience-denied`, `credential-conflict`, `rate-limited` (`retryAfterMs` ≤ 5000). Resolver outcomes stay `ok: false`, with six new reasons. Audit is coalesced per `(plugin, method, code)` with a 60 s summary; transport failures get a fixed public message and a bounded `data.kind`, not a sanitiser. Broker → HTTP 403 terminal / 429 / 499 / 502; worker retries only 429 and 502-504 (§3.6, §4.1.5, §4.1.7). | Distinguishing foreign from unknown handles would let a plugin probe another's handle space; a 504-for-everything broker and a worker that retries broad `APIError` classes would turn a denied lease into repeated requests and a silent degraded search; a per-raise audit would let a refused flood do unbounded work; a regex cannot prove credential bytes are absent from arbitrary text. |
| 17 | **Raw scope and the export rule.** `secrets:raw-api-key` gates `resolveApiKey({ exposure: "raw" })` only. The shared secret gate gains an operation axis: `getSecret` is `export`, refused for the host-provider secret class for every plugin before the read; `resolveApiKey` is `lease`, which keeps the unchanged tiers including the entitlement rows (`grants.ts:41-44`) and provenance (`:87-111`, `secret-gate.ts:190-215`) for both exposures; raw adds the capability in the reviewed authority and a receipt reviewed on app version ≥ X; every denial precedes the secret read (§4.1.6). | Deleting the entitlement rows was rejected because `getSecret` and the resolver share one gate that denies a missing row before provenance, so the rows' removal would deny every host-key lease; an operation rule by secret class is generic and needs no plugin-id branch. An inert string in an old artifact was never shown as a privilege, so its bytes cannot be consent for one. |
| 18 | **Publication prerequisites advanced into Lease.** Protocol-aware catalog selection (`hostProtocol` in descriptor and index, a `host_protocol` exclusion), final-tag contract and checker sync, the protocol schema as a vendored artifact (so `portal`'s two-file inventory changes). The TS client and the validate CLI stay in Publication (§6.3, §6.4). | The `"2"` pin needs the bytes it pins and a sync must not offer what the app cannot run; the client and CLI are conveniences with no compatibility consequence. |
| 19 | **Publication sequence.** One timeline: tested candidates and the 14-day notice before the tag → app tag with the installer release held as a draft (E1) → re-vendor from the tag → publish plugins, pins and both index files → packaged matrix against the published artifacts → publish the app draft → promote the schema alias (E2, the alias names the newest copy `mirror.json` marks published, §6.1, [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) M1); alerts versions first, Lease versions after, no combined bump; `assistant` revocation stays with 0.11.0 and a revoked plugin is outside the replacement set ([§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19), §6.4). | The draft release (`build-installers.yml:308-316`) separates tag creation from rollout, which is what lets replacements exist before an old artifact can be refused; a replacement vendored from a tag cannot be required before that tag, so the earlier "replacements before the tag" wording was circular and is withdrawn. |
| 20 | **Budgets.** The numbers of §7.4: 50/s default, `hostFetch` 20/s, `resolveApiKey` 10/s, notifications dropped and counted, 64 in flight, 256 subscriptions with per-kind caps, 32 leases; keyed by plugin id, cleanup exempt; dispatcher-only scope stated. | Sized from the configured 400 RPM indexer batch rate as an input with ~3× headroom, to be confirmed by the measured acceptance run; not from the number alone. |
| 21 | **Multipart and upload budget.** The reference runtime serialises `FormData` to bytes with a generated boundary, counting as it appends and refusing before over-allocation; the 16 MiB cap is the entire serialized body and stays; 15 MiB is `meeting`'s audio target under it with non-file fields bounded; the direct 25 MiB upload route joins the staged route's segmentation for anything that would exceed the budget, the staged 500 MiB limit stays, and both return the structured `file-too-large` result (§8). | A `FormData` body is refused by the encoder today, reproduced by the cross-review; raising the cap would move the frame and memory bounds for every member to fix one caller; lowering only the staged segment check would leave the direct route sending 25 MiB in one request. |
| 22 | **git.** The "all mediated / no ambient axis" claim is withdrawn; direct `fetch` and the `~`-expanded external `dataDirectory` are Admission prerequisites, not Lease work ([§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps), [§9.2](../history/plugin-hostapi-protocol-migration.md#92-order-of-plugins)). | Source at `d71fb95` shows two global `fetch` sites and a home-relative cache; keeping `git` in process during Lease does not make those Lease's to fix, and claiming isolation from a method list would be false. |
| 23 | **Slicing.** Host PRs A, B, C, D, E1, E2 of [§9.6](../history/plugin-hostapi-protocol-migration.md#96-host-pr-slicing-and-gates-for-the-lease-step-decision-23): B independent; C ships the sandbox authority and format-2 catalog while **retaining** `PLUGIN_ENVELOPE_GRANTS` as the source for undeclared artifacts (owner: the organization owner role; removal condition: D); D is the single protocol-2 boundary that serves `2`, retires `1`, refuses undeclared and `"1"` manifests and deletes the table; E1 is the pre-tag release PR; E2 is the post-tag runbook whose gates are on the published release. | Each slice is coherent at its boundary; the places a slice could hide a break are named and forbidden: a typed `auth` field without enforcement in D, a deleted table while protocol `1` is still served in C, and a tag whose creation depends on receipts vendored from itself in E. |
| 24 | **Catalog format 2** (superseded 2026-10-14: one `marketplace.json` with `schemaVersion: 2` inside, no frozen format-1 file, any other version refused). As first decided: a frozen format-1 file for pre-X apps beside a format-2 index carrying every version with `hostProtocol` and `authority.sandbox`; descriptors gain `schemaVersion: 2` (§6.4). | The index root, version and authority objects are closed and a package is validated whole, so any new field in the shared file drops every version of that package from every older client, which would break the "old app keeps its old versions" promise the downgrade and rollback rows depend on. A presence-declared format is deterministic; a tolerant reader or a retry is not. |
| 25 | **Approved-root withdrawal.** A resolved envelope has two inputs, manifest authority and the approved-directory ceiling; when either stops covering a running incarnation's grants the runtime retires that incarnation and its delegated workers before the change is acknowledged, marks `sandbox-grant-outside-ceiling`, and refuses a restart until the config or the ceiling changes; overlapping roots keep a grant; the boot reconciler runs before plugins load (§2.2). | The kernel envelope cannot narrow after spawn (`out-of-process-plugin.ts:682-687`) and root removal already revokes permission signals (`permission-manager.ts:1148-1155`), so an update-only rule would leave a child using a withdrawn root until its next restart. |
| 26 | **Linearised issuance.** `issuing` starts before the first authorization await: resolve the key identity, capture `{ incarnation, permissionEpoch, secretGeneration(key), providerConfigRevision }`, reserve a registration slot, run the gate and reads, then compare-and-register in one synchronous section or deny `stale-authorization` and return the slot; the store gains generation hooks at every transition of the state the resolver can see — the in-memory provider-configuration mutation before its save, the rollback after a failed save, every change of secret readability, and the completion of a secret write or delete — never only on successful commits (§4.1.2). | Counters alone do not say which snapshot a lease represents; without a reservation, concurrent resolves can all observe 31 and exceed the cap; re-reading into a new epoch would silently launder a stale authorization; the store makes a configuration visible before it is saved and restores the saved one when the save fails (`settings-store.ts:1114-1116`, `:1978-1993`), so a post-commit counter would leave a lease bound to a rolled-back endpoint usable. |
| 27 | **Publication slicing ([§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan)).** P0 design; P1 client, M1 mirror alias rule and S1 protocol-session seam independent of one another; P2 validate CLI and P3 `process` runtime after S1; P4 marketplace admission and P5 cross-language smoke after P3; E1′ the 0.13.0 release PR; E2′ the post-tag plugin-repository sync, drift-script retirement and alias promotion. **One fixed merge order**, P0 → S1 → P1 → M1 → P3 → P2 → P4 → P5 → E1′ (M1 done: #2591, `9c56ec148`), with development parallel after S1; every shared file follows it (the later slice rebases and integrates). The one slice that changes the protocol schema is P3 (the `PluginManifest` wire change, decision 33), which refreshes the open `2/v0.13.0` candidate and the client in the same PR. | The mirror check freezes the canonical schema on `main` between a tag and the next bump, and #2589 made that bump the first change after v0.12.0 ([§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan)). The first round let P2 and P3 start at once against one factory and they required incompatible behaviour of it (both reviews' P0); freezing the session interface in S1 first is what lets P2, P3 and P5 proceed in separate checkouts without inventing a bypass. The second round's "any order" beside an ordered file matrix was two orders (host re-review #24); a single order with P1 before P3 and P3 before P2 removes every conditional ("if P1 merged", "the second of P2 and P3"). |
| 28 | **The TS client carries no app version** and is generated from the committed schema, not the TS sources; `json-schema-to-typescript` 15.0.4 is the one new dev dependency; the client is vendored by sha256 from the tag and not mirrored on the site. | A file that embedded the app version would change every release with no method change; the schema is the published artifact, so a client provably projected from it is one any language can reproduce; the mirror exists so `$id` resolves for editors, and a second web copy of the same bytes is the duplication decision 6 rejected. Rejected: a compiler-API type printer (a second projection of the sources with its own drift). |
| 29 | **`HOST_PROTOCOL_FIRST_APP_VERSION`** (`{ "2": "0.12.0" }`) beside `HOST_PROTOCOL_VERSIONS_SERVED`, held by a test to the lowest `appVersion` recorded for that protocol in `mirror.json`; the validate CLI enforces `minAppVersion ≥` it. | [§9.4](../history/plugin-hostapi-protocol-migration.md#94-the-wire-step-implementation-plan) item 6 promised the rule to the validate CLI; a constant read from the mirror's history is derivable and gated, where a literal in the CLI would drift. |
| 30 | **The validate CLI does not confine the child, and never reaches the production factory.** It spawns a plain process and attaches it through `openValidationSession` (`src/plugins/validate/validation-session.ts`, owned by the validate directory), the validation-only entry to the protocol-session layer `openPluginProtocolSession` that S1 extracts; the conformance goldens use the same entry. `createOutOfProcessPluginFactory` keeps admission and `spawnConfinedChild` with **no** substitution point and no bypass flag (`OutOfProcessPluginSpec.connect` is deleted; its only test seam is the observation-only `observeChild`, decision 43), and an import-boundary test proves nothing under `src/plugins/runtime/`, `src/boot/` or `src/main/` reaches `src/plugins/validate/`. The validator's authority is explicit: a table bound to the plugin's base envelope, with no declared grant applied (decision 43). Confinement is the host suite's (§10.1 item 3). | A validator that wrapped would need ASRT and the host's sandbox state on the author's machine, including Windows; a green wrap there would prove nothing about the host's, and a red one would block authors on a substrate they do not ship. One factory cannot both refuse every unconfined process launch and serve an unconfined validator; separating the session layer from admission and spawning lets each keep its rule. Rejected: an `unconfined` or `validationMode` flag on the factory (a bypass reachable from a runtime path). superseded 2026-11-06 (#447) |
| 31 | **`tools/call` in the validate CLI** is issued with `{}` for tools with no `required` input, from `--tool-args` for the rest, and reported `not exercised` otherwise, never failed. | A generic validator cannot invent meaningful arguments; a failure it cannot justify would train authors to ignore it. |
| 32 | **`process.command` is inside the plugin root only** (`./` or `${PLUGIN_ROOT}/`); the schema pattern and the hardening refuse a bare name; §2.1's earlier "bare executable name" is withdrawn. | §7.3 already ruled out a `PATH` search for a marketplace plugin, and a `process` entry exists only as a marketplace plugin (§2.1); two rules for one field would leave the schema admitting what the runtime refuses. |
| 33 | **The protocol change Publication makes is the `PluginManifest` wire type**, which construct carries (`plugin-instance-wire.ts:82`; `protocol.schema.json:7116-7117`): the public type becomes the exclusive union `EntryPluginManifest \| ProcessPluginManifest` (each branch declaring the other's key `?: never`), and the schema generator projects a `never` property as a `false` subschema, so the wire schema rejects both and neither (today `entry` is in one object's `required` list, `:7503-7508`). Construct's `entryPath` stays required and is, for a `process` launch, the resolved absolute command path; its description is amended. P3 regenerates the schema, the `2/v0.13.0` candidate and the client in one PR and adds a process-launch construct golden validated against the regenerated schema. | A `process` manifest cannot cross construct without the type change; the first round's "only the `entryPath` description changes" and "the client changes only when methods change" were both wrong, since the client projects every `$defs.types` entry. Making `entryPath` optional would be an additive change a `2` client tolerates (§3.3) but a second shape for one field with no consumer that needs it. Two optional properties would project to a schema that accepts both keys (host re-review #20); the generator drops `never` properties on its own ([§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) P3), and a rule keyed to `never` in the source is general where a `PluginManifest` special case would not be. The open candidate permits the change ([§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan), mirror freeze). |
| 34 | **No new descriptor or index field for `process` in 0.13.0.** Admission reads, per version, `platforms` (present, without `win32`), the declared `release`/`archive` sha256 pin with no `tree`, and `minAppVersion ≥ 0.13.0` (decision 38), and trusts the **verified** rung the receipt records; the declared pin is only what makes that rung reachable. `ExpectedPlugin` gains `platforms` and `artifact` and every producer fills them. The sandbox-off refusal on macOS and Linux is pre-activation but post-download. A `runtime` field is the first candidate for a catalog format 3. | Format-2 version and authority objects are closed and a package is dropped whole by a 0.12.x app when one version carries an unknown field (decision 24), which would remove every process-entry package, old versions included, from every 0.12.x client; `platforms`, the pins and `minAppVersion` already reach catalog selection (`catalog/aggregate.ts:85-89`). |
| 35 | **One provenance gate on every activation path.** `assertProcessEntryAdmitted(manifest, verified)` runs first in `importPluginFactoryForLifecycle` (`runtime/index.ts:5143`), before routing, and every caller passes its own verified evidence: boot preflight, `instantiateAndStartSinglePlugin`, `restartPluginInternal`, and `activatePreparedArtifact`, which verifies the staged `receiptRaw` with `verifyInstallReceiptRaw` first. `PluginIntegrityCheckResult.verified` gains the receipt's `rung`. A `process` manifest passes only with `installSource: "git"`, rung `release` or `archive` and a non-null `artifactSha256`; everything else that reaches the gate, including a `local-dev` receipt under dev unlock and a valid receipt the path did not verify, is `process-entry-requires-pinned-artifact`. **Precedence:** receipt integrity first (a directory with no receipt is refused there, fail-closed, before the manifest is read at boot and before materialisation elsewhere), then this gate, then routing, then the sandbox check at spawn. The gate lands **in P3**, with the runtime it guards, and is tested per path, the precedence cases included. | All four paths reach the factory through that one function ([§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) fact 8), and the integrity result dropped the rung, so a gate on the marketplace install path alone would leave an on-disk tree-rung or hand-placed process manifest able to run through boot, restart or prepared activation. Rejected: keeping `process` refused in P3 until P4 — the gate needs nothing from the marketplace, and shipping the runtime without it would create a state where the runtime exists behind a refusal that a later slice must remember to replace. Rejected: a manifest-aware classification before the receipt check so a no-receipt directory gets the process code (host re-review #22's alternative) — it would read and classify bytes no receipt vouches for, on a failure path, to change only the message. |
| 36 | **No manifest byte reaches the confinement wrapper's environment.** Manifest `env` names pass `isSafeMcpEnvironmentName` (`src/mcp/safe-names.ts:50-53`: `RESERVED_ENV_NAMES` case-insensitively, the launcher family, and `PLUGIN_ROOT`/`PLUGIN_DATA`, whose comparison P3 makes case-insensitive too) at hardening, install, load and in the CLI. The spawn runs `/usr/bin/env <manifest pairs> PLUGIN_ROOT=… PLUGIN_DATA=… <command> <args>` **inside** the wrap, the host-owned pair after the manifest pairs so it is authoritative; the outer wrapper sees `buildSafeChildEnv()` and the sandbox HOME only. `=` is refused in `process.command` and in a resolved command path. An interpreter path such as `PYTHONPATH` is set by the plugin's own launcher inside confinement, from `PLUGIN_ROOT`. Negative tests prove `BASH_ENV` and `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES` placed below the hardening execute nothing before confinement. | With the sandbox active the outer executable is ASRT's `/bin/bash -c` wrapper, which reads `BASH_ENV` from its own environment before the sandbox command runs ([§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) fact 9), and `buildSafeChildEnv` lets extras override host variables. Reusing the MCP rule keeps one reserved-name list. Rejected: a process-entry name list of its own (two lists drift); passing declared variables through `extraEnv` (they reach the outer shell); a `PYTHONPATH` exception in the host (the reviewer's example, withdrawn because the name is reserved and the launcher can set it inside the wrap). |
| 37 | **Two contained-path rules for a `process` entry.** The executable is anchored by `anchorBundledCommand`: realpath inside the retained generation, `O_NOFOLLOW`, a regular file. An `args` element or `env` value beginning `${PLUGIN_ROOT}/` goes through a new `containedRootPath`: relative segments only, the path must exist, its realpath lies inside the root, and it may be a file or a directory. `${PLUGIN_DATA}` tokens keep `containedDataPath`. Other `args` literals keep the resolver's undeclared-path rule; other `env` values are opaque literals without `${`. | A vendored tree is a directory, and `anchorBundledCommand` refuses anything but a regular file (`plugin-bundled-command.ts:56-58`); the artifact is immutable, so a missing root path is a manifest error, while a data path's leaf may not exist yet. |
| 38 | **`PROCESS_ENTRY_FIRST_APP_VERSION = "0.13.0"`**, separate from `HOST_PROTOCOL_FIRST_APP_VERSION["2"] = "0.12.0"` (decision 29). A `process` manifest must declare `requires.minAppVersion ≥ 0.13.0`; hardening, the validate CLI, the ladder's manifest rules and the repository checker (per released version) enforce it. | Protocol `2` began at 0.12.0 but no 0.12.x app has a process runtime; catalog selection filters by `min_app_version`, so the floor is what keeps a 0.12.x client from selecting a version its runtime refuses. |
| 39 | **The mirror alias for a protocol always names its newest published copy**, enforced whether or not a candidate is open; promotion (`sync-plugin-host-protocol-mirror.mjs --publish <protocol>/<version>`) sets `publishedTag` and writes the alias from the maximum published version. M1 lands before either Lease's `2/v0.12.0` promotion or the `2/v0.13.0` promotion. | The check skipped the newest-published rule while a candidate was open (`plugin-host-protocol-mirror.mjs:107`), so a late `v0.12.0` promotion after the next bump could move alias `2` backwards unnoticed, and without a candidate the old "move the alias to that entry" instruction would fail after a `v0.13.0` promotion. Enforced order-independence removes the ordering constraint between two runbooks owned by different steps. |
| 40 | **Stdout discipline is proven on the raw bytes, and the production decoder stays tolerant.** The validate CLI and the confined-child suite tee stdout and fail on any line that is not a JSON object terminated by `0x0A`, including a `Content-Length:` header; `StdioFrameDecoder` still drops such a line in production. | The decoder drops malformed lines by design (`stdio-framing.ts:35-46`), so counting decoded frames cannot see a violation. A strict production decoder would turn a stray line into a failed plugin for every installed plugin mid-release, a contract change with no notice or replacement path; the reference runtime already takes stdout away from plugin code, and the validator catches a non-JS plugin's violation before publication. |
| 41 | **Plugin resource cost is measured on the child, not on the test runner.** The confined-child harness samples the spawned wrapper's process tree with `ps` every 50 ms from spawn to exit (RSS in KiB on both platforms) and records peak RSS and spawn-to-construct time for the Python smoke and the `meeting` fixture; the Python child also reports its own `ru_maxrss` as `params.meta.ruMaxrss` of its last log notification, normalised per platform, and the golden canonicalises exactly that field to `"<measured>"` after recording its raw value, and replaces the temporary plugin and data roots (as allocated and after `realpath`) and the validation context's `hostRoot`, `userHome` and `aveHome` with named placeholders, guarded by a throw if `os.tmpdir()` or the checkout root survives; the repeat-run byte-equality check records twice with independently allocated roots and compares both to the committed golden. The numbers are reported, not gated, and the UNVERIFIED item stays open until a run produces them. | `process.resourceUsage()` reports the calling Node process and its peak persists across tests (Node documentation, <https://nodejs.org/api/process.html#processresourceusage>, checked 2026-09-28); a gate sized before any measurement exists would be a guess (decision 7). An RSS value in a golden would fail it on unchanged wire behaviour (cross-language re-review 4); a rule keyed to one field keeps every other number exact. A `mkdtemp` root differs on every run and is outside `goldenPath`'s fixture root, so without its own rule the golden holds a path no other run can produce, and a repeat run that reused one root would not notice (cross-language re-review round 3, finding 2). |
| 42 | **Retired sources are outside validation by absence, not by a skip list.** The official repository's validation targets are the tracked sources that remain after the candidate wave (`feat/lease-candidates`, `e53fb40a8`), whose commit `0835fd2` deletes `plugins/assistant/source` and keeps its entries in both catalog files and its revocation entries. E2′ item 1 waits for that wave; the CLI then runs unconditionally for every discovered directory. | The revoked plugin is outside the replacement set ([§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19)) and its source cannot pass protocol-2 validation; a lifecycle flag or skip list would be a way to switch validation off, while deleting the source leaves nothing to skip and keeps the catalog and revocation records that clients still need. |
| 43 | **The protocol-session layer's authority is an input, and its controls are split by consequence.** `openPluginProtocolSession` requires a `BoundHostApiDispatchTable` — branded, produced only by `createBoundHostApiDispatchTable`, which moves to `bound-host-api-table.ts` — and never derives or defaults an envelope. Production binds it to **the same envelope value** the spawn received; the validation host binds it to `validationConfinement`, the plugin's base envelope with no declared grant applied and no read of the user's approvals. The session returns a non-destructive `channel` (`requestMcp`, `probe`, `runStopHook`, `closeInput`, `exited`) and one destructive `teardown`; `instance.stop` is `runStopHook` then `teardown`, unchanged in production. `teardown` is the only destructive call: a child that exits by itself is observed (`onGone` → the transport's `peerGone`), and the session releases its watchers, pending calls and dispatcher state and runs `onClosed` once **without** `terminate`; a deadline or a fatal framing error still reaches `close` and terminates. `onGone` is terminal-only — an exit, or an `error` from a spawn that produced no process — and an `error` on a live child (a failed signal delivery) goes to the required `ChildLink.onFault`; the transport starts at most one termination sequence (`link.terminate`, flagged before the call because a refused `kill()` emits its `error` synchronously), a fault with no sequence active starts it through `close`, and a fault during it is only recorded — the link's own SIGKILL after the grace period is the retry, and a refused SIGKILL leaves `exited` unsettled with no further signal; `channel.exited` settles only on an observed exit. Both openers take an optional `signal` honoured from their first line, so a caller can cancel while construct is pending; an abort is `teardown`, and a construct success that races it is torn down, not returned. The production factory's only test seam is `observeChild` (`pid`, `onStdout`, `endInput`, `exited`), called after the wrap; it cannot supply, replace or re-spawn the child, see the envelope or table, write a frame or terminate. All of this is frozen in S1, and S1 migrates the 28 `connect` consumer sites. | `createServiceHostApiPaths` makes the envelope required because an omitted one "would silently mean 'unbounded'" (`host-api-dispatcher.ts:1352-1360`); a session that derived its own could check delegated workers against something other than the jail (`out-of-process-plugin.ts:157-165`), and a validator that read `~/.ave/config/settings.json` would validate against one user's approvals (both re-reviews' P0). The factory's `stop` always terminates (fact 14), so a stdin-close test built on it measures the termination, not the rule (host re-review #18, cross-language re-review 2); and while `onGone` is wired to `close` (`plugin-child-transport.ts:154-156`), a natural exit also calls `terminate`, which the third round found the second round's text still allowed (host re-review #25, cross-language re-review round 3, new 1). Both process adapters forward every `error` to `onGone` today (`out-of-process-plugin.ts:973-982`, `child-process-config-wire.test.ts:218-222`), while Node emits `error` for a signal it could not deliver to a running process (<https://nodejs.org/api/child_process.html#event-error>, checked 2026-10-01) and `managed-child-processes.ts:109-113` already keeps such a child; treating that as an exit would release a live child and let `closedReason` swallow its termination (host re-review #28). The opener returns the session only after construct (`out-of-process-plugin.ts:1436-1446`, `:1544`), so a caller's deadline that fires during construct had nothing to cancel with (host re-review #29). Re-terminating on every fault recursed: `terminateChildProcess` sends SIGTERM before arming its timer (`terminate-child-process.ts:16-30`), so `terminate → kill → error → fault → terminate` nests without bound (cross-language re-review round 5, reproduced with Node's own `kill`). Rejected: re-terminating on a fault after `close` (that recursion); a separate `cancelConstruct()` handle (a second cancellation path beside `teardown`); making `signal` required (production's factory timeout already disposes a late instance). The confined suite needs the real child's bytes, PID and stdin (fact 15); a seam that could substitute the child is the bypass decision 30 removed, one that only observes after the wrap is not. Rejected: a pre-bound table passed as a plain `Record` (a hand-built or unbound record would type-check); an envelope input to the session (it would bind the table itself, a second binding site); an `unconfined` flag (decision 30). |
| 44 | **One producer of MCP request metadata on the plugin-child channel.** `PluginChildTransport.requestMcp` stamps `_meta` with `io.modelcontextprotocol/protocolVersion: "2026-07-28"` and `io.modelcontextprotocol/clientCapabilities: {}` on `server/discover`, `tools/list`, `tools/call` and `resources/read`, and refuses a caller `_meta`; `request` takes `ave/instance/*` only and `ave/*` frames carry no MCP `_meta`. `clientInfo` is omitted. Decision 63 adds a third key, `ave/invocation`, on `tools/call` only. The reference runtime's tolerance of a missing version is unchanged; the Python fixture rejects a request missing either required key with `-32602`, and the validate CLI checks the host-side frames. Landed in S1 with the goldens regenerated. | MCP `2026-07-28` makes both keys required on every request and a request without them malformed (fact 16); the factory sent neither on `tools/call` or `resources/read`, and a tolerant runtime hid it. `{}` is truthful: the host serves no server-to-client MCP request on these pipes (`plugin-child-transport.ts:242-247`). `clientInfo` is a SHOULD, display-only and self-reported; an app version in every MCP frame would move every golden at each release. Rejected: making the reference runtime strict in 0.13.0 (it also serves the in-process loopback, whose internal caller it tolerates by design, `plugin-mcp-server.ts:233-237`, and a behaviour change for every installed plugin is not Publication's); stamping in the session instead of the transport (two call sites, and the validator's requests would need a third). |
| 45 | **Vendored bundles use the official repository's post-wave recipe, and the host logger is silent in them by intent.** `ave-plugin-validate.js` and `ave-plugin-child-main.js` are `tools/vendor/` `build` entries with `logger: "stub-app-logger"`, built by `bundle-app-marketplace.mjs` via `buildAtRef`; the portal and repository plugins adopt the same recipe byte-for-byte; ave's bundle test runs that recipe from a fixture copy that names its commit. Source mode (`npm run plugin:validate`) applies the same substitution through `scripts/lib/stub-app-logger-hook.mjs`, a resolve hook loaded in the CLI and its child, and each mode's test parses every stdout line as a report row. | At the wave `vendor.mjs` refuses any other logger recipe (`:92`), so the pre-wave plain `bun build` the second round named could not be vendored (cross-language re-review 7). The app logger writes to stdout outside a headless run (`logger.ts:70-99`) and the CLI's stdout is its report; the child’s diagnostics use stderr. Reproduced 2026-10-01: the recipe builds `plugin-child-main.ts` at `c73f59580` with no `pino` and no embedded path (fact 17). In source mode neither `LOG_LEVEL` nor rebinding `process.stdout.write` is enough: the logger's test-mode path calls `console.log` whenever `VITEST` or `NODE_ENV=test` is set (`logger.ts:37-38`, `:223-259`) and its pretty stream defaults to stdout (`:93-99`), so only replacing the module covers both (host re-review #27, cross-language re-review round 3, new 3). Rejected: a source-mode-only flag in the logger (a second silencing mechanism that the bundles would not exercise). superseded 2026-11-06 (#447) |
| 46 | **The Python smoke provisions one interpreter in one tree.** Every uv call runs with `UV_PYTHON_INSTALL_DIR`, `UV_PYTHON_BIN_DIR`, `UV_PYTHON_INSTALL_BIN=0` and `UV_CACHE_DIR` under `node_modules/.cache/ave-python-smoke`, discovery is `--managed-python`, every job that runs the smoke ensures uv with `scripts/fetch-uv.mjs` before it, and CI supplies the interpreter through `AVE_SMOKE_PYTHON` from `actions/setup-python`, except the self-hosted macOS job, which takes the uv path so nothing installs outside its workspace. The launcher is tested by running `bin/plugin` under `env -i` and checking the imported `mcp` comes from `<root>/vendor`. | `--install-dir` alone does not tell a later `find` where to look, default discovery falls through to `PATH`, and from uv 0.8.0 an install links an executable into the user's `PATH` (fact 17; cross-language re-review 6). The confinement jobs had no uv step and a cache hit skips the postinstall (re-review 5). A preflight that sets `PYTHONPATH` itself cannot fail when the launcher forgets to (re-review 9). |
| 47 | **Every call the validate CLI awaits is bounded, by `runProtocolChecks`, from `TOOL_TIMEOUT_POLICY`, and cancelled through one `AbortSignal`.** Construct `pluginFactoryMs`, the runtime's activation bound (the session's 20 s `pluginImportMs + pluginFactoryMs` stays as the transport's cleanup deadline, not a validation bound); `start` the manifest's `startupTimeoutMs` clamped to `pluginStartupMaxMs`, else `pluginStartupDefaultMs`; `onPublished` the same value as validator-only policy, since the runtime does not bound it; `server/discover`, `tools/list` and the unknown-method probe `mcpRequestDefaultMs`; each `tools/call` `globalCeilingMs`; the stop hook `pluginStartupDefaultMs`; `closeInput` → `exited` 5 s; `--fast` caps each of these at 1 s. A CLI-owned `finally` always runs — also when an opener rejects and no session exists — through the run's `AbortController` and the CLI's link, which records the exit, faults and signals from spawn; it starts the link's one termination sequence (`VALIDATION_KILL_GRACE_MS` 3 s, production's) unless the child already exited and waits `VALIDATION_TEARDOWN_WAIT_MS` 5 s for the exit; `protocol.teardown` is always reported, never `not exercised` and never capped by `--fast`. Expiry fails that row with `timed out after <n> ms` and aborts the run's controller, which the session (given it as `signal` before construct) turns into `teardown`; every later row is `not exercised` and the exit code is 1. | The CLI drives the session directly, so the runtime's owners (`runStartWithTimeout`, `src/plugins/runtime/index.ts:1242-1256`; the executor ceiling, `src/tools/executor-ceiling.ts:56-76`) never run, and the transport sets no timer for a call without a deadline (`plugin-child-transport.ts:159-165`, `child-stream-multiplex.ts:287-290`): a child that answers construct and then goes silent would hang the CLI and CI (host re-review #26). Reusing the production values keeps a plugin that passes validation inside the bounds the app will apply: activation bounds the whole child construct, import included, by `runPluginFactoryWithTimeout` at `pluginFactoryMs` (`runtime/index.ts:1215-1227`, `:4007`, `:4912`, `:5528`, `:6282`, `:5151-5154`), so the round-3 bound of import plus factory would have passed a plugin the app refuses (host re-review #30). `onPublished` is awaited unbounded (`runtime/index.ts:3437`); its bound is labelled the validator's own policy rather than parity. Rejected: a single CLI-wide timeout (it would report no row and could not tell a slow `start` from a hung tool); bounds inside the session (the runtime owns production bounds, and a second owner there would race it). superseded 2026-11-06 (#447) |

| 48 | **Distribution of plugins outside the official index (owner, 2026-10-03).** A plugin that is not listed in the official marketplace repository is distributed through another marketplace source, which users add as a custom source and administrators as a managed policy `additional[]` entry. The design plans no fallback to the official index for such a plugin. | The official repository's checker admits an official plugin only as a release asset of that repository (`tools/check.mjs:88-91`, `release.mjs verify`). |
| 49 | **Plan only for the plugin side (owner, 2026-10-03).** The plugin-side slices (G0, G1, C1, C2, C3) are planned outside this document. The host slices (A1, A2, O1, O2, R1, the code half of P7) are not held. | The host work has no dependency on the plugin work (fact 12 of [§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan)). |
| 50 | **Routing has no input.** `importPluginFactoryForLifecycle` routes every `entry` manifest to `createOutOfProcessPluginFactory` unconditionally; `OUT_OF_PROCESS_PLUGIN_IDS` and `isOutOfProcessPlugin` are deleted at Admission with their pins; the in-process import becomes `importInProcessPluginFactory` in `plugin-loader.ts` with no production caller, carried in the knip baseline with the owner (decision 5) and the removal condition ([§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)), and Loader removal deletes it; `bustCache` leaves the lifecycle method. | A host-owned plugin-id table is a plugin-specific branch once the arm it selects is the only arm (AGENTS.md); keeping the in-process factory as dead-but-tested code for two releases is the deprecation shape [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path) already defines, and a routing reversal is then a reviewed code change, never a runtime fallback. Rejected: an empty exclusion set as a dormant routing input (a branch no test can reach); deleting the arm in the same slice (it would collapse [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)'s two-release observation into nothing). superseded 2026-11-06 (#447) |
| 51 | **The removal predicate is fed by the registry.** `LoadedPlugin` records `arm: PluginLoadArm` from the routing function's return; `allPluginsAreOutOfProcess(loaded)` is true when every arm is `"child"`; the Doctor's plugin entry shows `arm` and `confinement` (`PluginConfinementReport`: the spawn's `SpawnConfinement`, or `"not-spawned"` for a construction that failed before a child existed); the "official index" clause of [§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps) is a test that routes every manifest of the committed official index to `child`. | The old predicate was a lookup in the census it existed to retire; a predicate over what actually loaded is what makes [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)'s condition checkable without fleet telemetry, and the Doctor fields are what decision 3 promised the user. superseded 2026-11-06 (#447) |
| 52 | **No migration shim for installed plugins.** On 0.14.0 every installed plugin loads as a child — every protocol-2 `entry` plugin outside the census (third-party, folder and direct installs) **changes arm**, and the release notes say so (R1); one whose child cannot be spawned or wrapped fails the load with the factory's existing error and the Doctor's `arm`/`confinement`, and is not retried in process; one that used an ambient capability fails at that call; the fix is the plugin's next version and the status's existing update path. A manifest with no served `hostProtocol` that reaches the routing function through prepared activation or restart is refused by the child factory's check inside the invoked factory; A1 reports it from the invocation catches (`runtime/index.ts:5141`, `:6443`) with the boot/add audit event — an update's refusal reaches the Updates card as the existing `PACKAGE_INCOMPATIBLE` / `host_protocol` failure (translated at `src/plugins/marketplace.ts:956`), a restart's reaches the config-save reply and the card's optional `lastAttemptRefusal` — never through `markLoadRefused`, and tests both the reporting and the untouched incumbent generation on both paths. No manifest field, setting or environment variable selects the arm. | Protocol 2 proves compatibility of the contract, not independence from ambient capabilities, so the earlier "no running plugin changes arm" claim was too strong (fact 12); decision 9 still refuses every pre-protocol-2 plugin before activation, and boot and add refuse an unserved version explicitly, but prepared activation and restart do not (the lookups at `runtime/index.ts:4962` and `:6374`; the check runs when the factory is invoked, `:5021` and `:6422`), and the factory's check (`out-of-process-plugin.ts:1057`) is the one gate every path shares after A1; a refusal that marked a running plugin failed would misreport the incumbent, so the report goes to the attempt's own surface. A per-plugin opt-out would be the routing input decision 50 removes. |
| 53 | **The adversarial fixture** lives at `src/plugins/isolation/__tests__/fixtures/adversarial/`, attempts the four escapes through `escape_secrets`, `escape_network`, `escape_electron`, `escape_patch`, asserts only where the harness claims confinement (`expectConfined`), is built first against the validate CLI (which asserts "no usable main-process API" by shape and the stdout discipline, and records the host-call probes) and then gated under the real wrap through the production factory, with the production secret gate, audit sink and `hostFetch` guard, on macOS, Linux and Windows with control cases that must pass first. The Electron claim is "no usable main-process API", never "no version" or "import throws" (the child is `process.execPath` under `ELECTRON_RUN_AS_NODE=1`); its positive control is a separate full Electron main process (`control-electron-main.cjs`, the same binary with `ELECTRON_RUN_AS_NODE` removed; under `xvfb-run` on Linux CI), never the test process, which runs as Node itself; the planted `electron` entry lives outside bare-specifier resolution (`vendored-electron/`, as the confined suite does) and the fixture is staged outside the checkout; the packaged gate's control is the packaged application's main process, launched through Playwright's Electron driver against the installed build with the gate's own environment allow-list (no `ELECTRON_RUN_AS_NODE`, no profile of its own) and evaluated with `app.evaluate`, because a packaged executable without `ELECTRON_RUN_AS_NODE` starts the application, not a helper — a development-helper result is never packaged evidence; the secret claim is `null`, no bytes, a denial audit under the spawn-bound identity and an own-namespace positive control (production `getSecret` returns `null` on denial, `host-api-factory.ts:984-987`). Escapes 1–2 are added to the Python smoke. | The validator never confines (decision 30), so a filesystem or socket claim there would be false; the wrap suite is where the host's claim is made, and a probe that cannot be shown live is no evidence (a failed control fails the file). The first draft asserted a wire error code for a denial and an undefined Electron version, both contradicted by the production launcher and the existing measurements (`confined-plugin-child.test.ts:1487-1515`); the second took the test process as the Electron control, which runs under `ELECTRON_RUN_AS_NODE=1` (`run-vitest-under-electron.mjs:154`) and so measures the trap, not the API, and put the planted package where a bare `require` would resolve it. |
| 54 | **`git` 0.3.0 prerequisites.** Egress through a once-bound `hostFetch` that throws when absent (no global `fetch`), caller `Cookie`/`Authorization` headers kept (no lease, §4.1.4), `authCookiePartition` not adopted (two partitions), a static `networkAccess.allowedDomains` of a GitLab host, `github.com`, `api.github.com`, `api.openai.com`, `openai.azure.com` with `allowPrivateNetworks: true`, and a configured LLM endpoint outside it refused, never widened from config; `dataDirectory` as a `sandbox.write` `userChosenDirectory` grant, `~` refused by the plugin's tools with one sentence where plugin code runs and by the host's resolver at spawn with the host's generic guidance ("enter an approved absolute directory, or clear the setting", added by A1 for every key), the stored value rewritten by nobody, recovery tested; `requires: { minAppVersion: "0.12.0", hostProtocol: "2" }`; retired manifest fields dropped; published only after these, so #27 (0.2.2) is superseded. | The allow-list is manifest authority the marketplace pins and reviews (decision 11), so a config-driven widening would be authority the review never saw; the host's resolver already refuses `~` (`out-of-process-plugin.ts:408-427`) but names no way out, and a host-side rewrite of one plugin's setting would be a plugin-specific branch; a plugin that cannot run cannot migrate its own value, so the host's generic sentence names the setting and both acceptable actions. |
| 55 | **Another marketplace source** carries `marketplace.json` (`schemaVersion: 2`) and `plugins/<name>/ave-package.json` descriptors pinned with `artifact.release: { url, sha256 }`, built with the official generator's rule. Its layout is the plugin side's concern. | `marketplace.json` is the only index the app reads (decision 24). |
| 56 | **Releases from the plugin's own CI.** A plugin outside the official index releases from its own CI with no publish credential in the release job; publication is a reviewed pin in its marketplace source. | Keeps the released artifact and the code that releases it apart. |
| 57 | **Installed-package migration to another source uses no new mechanism**: the §16.3 unmanaged notice, binding through policy `additional` + `requiredInstalls` (slice F), or a user-added source and an ordinary source switch (§16.4). | Everything needed merged in #2550–#2558 and #2615; a plugin-specific migration in the host would be a branch the architecture forbids. |
| 58 | **The official switch and the daily job.** `official.ts:27-32` becomes the public URL with `auth: { kind: "none" }` and merges only after the repository is public (anonymous `ls-remote` succeeds) and the owner says so; 0.14.0 ships with the token constant otherwise. The official repository's daily `published` job is left as it is; its failure since 2026-09-25 is the organization flag (anonymous 404 on a public repository), fixed by the owner's Support ticket, not by a token in a workflow. | A credential added to work around a platform flag outlives the flag; a repository-scoped `GITHUB_TOKEN` cannot read another organization's repository anyway; and a public repository that cannot be cloned anonymously is the defect, not the job. |
| 59 | **Loader removal, restated.** Condition (canonical in [§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan), "Loader removal, restated after Admission", which [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path) cites): the registry-fed predicate true on every Doctor report seen since Admission; the routing matrix, the official-index test and the §10.1 conformance suite green on the release tags of two consecutive releases (0.14.0, 0.15.0); and no change to `importInProcessPluginFactory` in those releases; owner: decision 5's role, recorded in `TODO.md` when A1 merges; boundary: 0.16.0 or a recorded reason. Not planned as immediate work. | [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)'s shape — its two-release conformance requirement kept — with the subject it now has. superseded 2026-11-06 (#447) |
| 60 | **P7 order.** Public release → fourteen-day notice ([§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)'s rule, applied to the server) → `.github` `marketplace-publish.yml` deleted → plugin repositories' GitHub publish workflows deleted → the web author page rewritten for format 2 → server stopped with volumes kept → Cloudflare route removed → repositories archived one release cycle later with the catalog exported to `project-history/`. Steps 3 and 5 are code and can merge now; step 4 is plugin-repository code that waits for the owner's go-ahead (decision 49); 1 waits for Actions; 2, 6–8 are the owner's. | Users must have the replacement source before the old one answers nothing; the catalog export is the only record of what the server served. |
| 61 | **0.14.0 carries no protocol boundary.** Admission changes no protocol schema; the `2/v0.14.0` candidate differs from `v0.13.0`'s copy by `$id` only; [§9.3](../history/plugin-hostapi-protocol-migration.md#93-removal-condition-for-the-in-process-path)'s notice rule does not apply to the release, only to the server (decision 60), because no protocol version is retired. | The arm change is inside the host's promise (§2.1); the notice rule is keyed to a retired protocol version, and none is. What 0.14.0 does refuse anew — a manifest without a served `hostProtocol` on the prepared-activation and restart paths (fact 12, decision 52) — is the rule 0.12.0 announced for every path, now applied by the child factory's check, and R1's release note names it. |
| 62 | **Migration of old-server installs of plugins outside the official index (designer, 2026-10-08).** Such a package can be **required** through policy (`requiredInstalls` from its source): a package that is not installed is installed by the boot step, and an existing install is switched through the idle apply queue after boot, never by an immediate boot install. `defaultInstalls` is not the migration path, because it skips an existing package bound to no source. An unmanaged install migrates by an explicit user-driven source switch. | Uses only the mechanisms of decision 57. |
| 63 | **An out-of-process tool's hostApi call runs in its host invocation.** The transport mints `_meta["ave/invocation"]` for each `tools/call` and keeps an `AsyncLocalStorage.snapshot()` of the caller's context. It keeps the snapshot for the life of the connection: settled calls are kept too, up to `SETTLED_INVOCATIONS_MAX` (1024, oldest dropped first). Live calls are never evicted; excess calls are refused before capture at `LIVE_INVOCATIONS_MAX` (64), so the tables retain at most 1088 snapshots. Close and observed exit release both tables before fallible termination or subscription teardown (`plugin-child-transport.ts`). The child runtime binds the token for the handler's async chain, including work the handler leaves running, and stamps it on each hostApi request (`plugin-child-runtime.ts`). The dispatcher runs a request in the snapshot its token names, refuses a token the connection does not hold, and runs a tokenless request in a context captured at module load, where no store is entered (`runOutsideInvocation`, `host-api-dispatcher.ts`). The transport also routes every frame off the pipe through that context. Residual: a child can still omit the token and run a gated write ungated. The host does not refuse it, but logs the first qualifying write per gated path per connection while a `tools/call` is in flight; repeated writes emit no more warnings. The module-load guard rejects both effect-gate and invocation-origin frames, including app-only tools without a gate frame; boot must still evaluate it outside unrelated stores. Additive within protocol `2` (§3.3). Pinned by `invocation-context.test.ts`, over a link that delivers in its spawn context, and by `plugin-child-transport.test.ts`. | After Admission A1 every entry plugin runs as a child. A child's hostApi request reached the host in the context of the pipe, not the invocation, so `gateMutatingEffect` read "no invocation" and passed every gated write unasked. A plugin tool's `raiseAlert`, or any other host-classified write, skipped both the foreground approval and the headless deny (blueprint `plugin-process-isolation.md` §7 Q5 expected it to survive the boundary). The pipe's context is the one the child was SPAWNED in, not a neutral one. A child restarted from inside a tool call (`config.set` → `restartPlugin`) would run every tokenless request of its generation in that finished invocation: a headless deny, a foreground allow-once grant and session attribution, and a growing effect ledger. Rejected: dropping a call's context when it settles (a handler's timer then ran fail-open, while in-process the same code is denied headless); gating every child write that has no context (it would also gate lifecycle work an in-process plugin does freely); refusing a tokenless gated write while a call is in flight (honest background work runs beside tool calls, and the host cannot tell the two apart); exiting individual stores instead of using one root context (the pipe also carries the install-lock, registry and lifecycle stores, and a list of stores to exit goes stale). |
| 64 | **Windows: plugins are not isolated from each other (owner, 2026-10-10).** On Windows every plugin, third-party ones included, runs in the one shared `srt-sandbox` identity: sandboxed from the host as configured, not from each other. The app adds no install gate, warning or confirmation, serialization of plugin processes, or marketplace-source restriction on Windows; the sandbox capability report says "against the host" there (`permissions.ts` `sandboxCapability`, `sandbox-capability-info.ts`), and every inter-plugin claim in this design and the blueprint is scoped to macOS and Linux. The same holds for the host's own READ grants there: a bundled hook or MCP stdio server whose program lives in `<AVE_HOME>/runtime` holds READ on that directory for its lifetime (`wrap-bundled-command.ts` `hostRuntimeReads`), and while held every confined process reads it too — acceptable because the runtime is the host's shipped interpreter and holds nothing private. It is an accepted risk, pending an ASRT per-plugin (per-execution) identity, and is re-decided when one exists ([§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan) A2, *As implemented*). | ASRT 0.0.80 runs every sandboxed process as one account, without restricting SIDs; its allows are session-level grants and its per-execution denies holder-refcounted ACEs, both on that account's SID, so a deny between plugins takes each plugin's own directories from it as well, and a grant to one is visible to all while held. Upstream `@anthropic-ai/sandbox-runtime` releases through 0.0.80 (checked 2026-10-19) add no per-execution identity. Rejected by the owner: an install gate, warning or confirmation for third-party plugins on Windows, serializing plugin processes, and restricting Windows to some marketplace sources — third-party plugins run on Windows. Rejected on the facts: a deny-based partition, which removes each plugin's own access (above). |
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

**Owner actions** (by role, not design decisions; [§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan)):

- Making `linux-confinement-tests` a required status (open since [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) P3), and
  `windows-permission-tests` with it once A1 merges.
- Making `ken-jo/agent-marketplace` public (or moving it), which gates O1.
- The GitHub Support ticket for the organization flag, which gates O2, R1's tag builds
  and P7 step 1.
- The fourteen-day notice date and the server stop, Cloudflare and archive dates of P7.
- Recording the loader-removal owner line in `TODO.md` when A1 merges (decision 59).

---

## UNVERIFIED in this document

- The RSS and wall-clock startup cost of one plugin child (§8). No measurement exists in
  the checkout; the conformance suite is asked to produce it — [§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan) P5 records it for
  the Python smoke and the `meeting` fixture in the confined-child run.
- Resolved 2026-09-28 ([§9.7](../history/plugin-hostapi-protocol-migration.md#97-the-publication-step-implementation-plan), "Facts this plan rests on"): `ts-json-schema-generator`
  2.9.0 is the generator's engine in production and the committed schema is its output;
  the stock MCP server SDKs speak `2026-07-28` (`mcp` 2.0.0 stable on 2026-07-28, 2.2.0
  current; the TypeScript 2.x packages), with the stdio drivers owning the pipes, so the
  Python smoke owns its stream and hands the library one message at a time.
- The real request rates behind §7.4. The 400 RPM batch setting is a configured
  input; resolve/fetch/release counts, retry amplification and concurrency under a
  scan, a caption pass and a meeting session have not been measured. The budgets are
  sized with headroom and are confirmed or changed by the acceptance run of [§9.1](../history/plugin-hostapi-protocol-migration.md#91-steps).
- The packaged old/new matrix of §6.4 and the plugin-status update path. They are
  design requirements here; no packaged upgrade, offline refusal, downgrade or consent
  update has been run.
- The live redirect and revocation behaviour of §4.1.2-4.1.3. The cross-origin
  `api-key` retention and the `FormData` and 17 MiB rejections were reproduced against
  the exported functions with synthetic inputs; no live provider, credential or
  revocation race has been exercised.
- Whether the alerts successor artifacts named in [§9.5](../history/plugin-hostapi-protocol-migration.md#95-the-lease-release-target-alerts-integration-and-publication-sequence-decisions-8-and-19) are published at the time the
  Lease slices start. The reviewed evidence is a development branch pin, not a
  release receipt; slice E verifies the published versions.
- ([§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan)) The exact filesystem error each substrate returns for an unbound read
  (`EPERM`/`EACCES` on macOS and Windows, `ENOENT` under bubblewrap is the expectation;
  Windows measured `EPERM` under srt-win on 2026-10-10, row 1a included — [§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan) A2);
  A2's assertions are per platform and the first run fixes the values.
- ([§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan) A2) An `uvx`-launched MCP stdio server under srt-win, end to end. The relay, the
  `<AVE_HOME>/runtime` read grant and the relayed environment are measured with Node
  programs; uv fetching an interpreter and packages through srt-win's proxy is not.
- ([§9.8](../history/plugin-hostapi-protocol-migration.md#98-the-admission-step-implementation-plan)) The Electron positive control on Linux CI under `xvfb-run` and on the Windows
  runner. macOS is measured (2026-10-08: Electron 44.3.0, `BrowserWindow` `"function"`,
  `app.whenReady()` resolves, `session.defaultSession` `"object"` — a development-executable
  result); the other two are recorded by A2's first CI run, as are all three
  packaged-control values (the packaged application's main process evaluated through the
  installed-build driver; a development-helper result is never packaged evidence), and a
  helper or packaged control that does not start fails the file rather than passing it.
