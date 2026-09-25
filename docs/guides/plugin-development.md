# Plugin Development Guide

This guide describes how to build Ave plugins against the current host
runtime. Korean source history is preserved in the
[Korean historical reference](../ko/guides/plugin-development.md).

## Plugin Model

An Ave plugin is an installable package with a manifest, optional UI bundle,
optional tools, optional settings schema, and declared host capabilities. The
host owns installation, policy, loading, UI containment, and tool execution.

Plugins should add workflow capability without assuming direct filesystem,
network, or process access. Those operations must be declared and routed through
host APIs or tool execution.

## Manifest Basics

Every plugin package needs a `plugin.json` manifest. The Host owns the canonical
shape in `schemas/plugin-manifest.schema.json` and the complete TypeScript/JSDoc
authoring contract in `src/plugins/public-contract.ts`. `@ave/plugin-sdk`
publishes generated mirrors of those two Host files.

The manifest should include:

- stable plugin id;
- display name and version;
- runtime entry point and optional UI declarations;
- pure MCP `Tool[]` objects with colocated input schemas;
- required capabilities;
- settings schema if configurable;
- `requires.minAppVersion`, which a marketplace install requires.

A JavaScript plugin leaves `requires.hostProtocol` out: the host's own runtime
speaks the plugin protocol for it. A plugin that declares one (a positive integer
written as a string, such as `"1"`) is refused with `incompatible-host-protocol`
by an app that does not serve that version, and an app whose schema predates the
field rejects the manifest outright, so its `minAppVersion` must name a release
that knows the field.

`tools[]` is the only callable surface. The retired `uiTool`, `uiTools`,
`uiAction`, `uiActions`, top-level `operationGovernance`, and top-level
`appAllowed` shapes are rejected. App/model visibility belongs on each Tool at
`_meta.ui.visibility`; operation restrictions belong on the same Tool at
`_meta["ave/operationPolicy"]`.

Manifest-governed operations do not dispatch PreToolUse, PostToolUse,
PostToolUseFailure, or PermissionDenied extension hooks. Their external state
boundary is the Host-owned operation policy, stable account serialization
scope, final audit, and read/write receipt flow; arbitrary hook commands cannot
participate in that proof.

`keywords[]` is retired and schema-rejected. Model guidance belongs in
plugin-owned instruction bundles declared by `manifest.skills`; callable
behavior remains in typed `tools[]`. Skills can guide the model to the relevant
Tool, while the Host's bounded tool catalog and `tool_search` control schema
exposure. The Host does not dispatch or silently preload Tools from keywords.

## HostApi Boundaries

Plugin code receives a host bridge. It must use that bridge for operations such
as:

- reading declared preferences;
- opening approved auth windows;
- calling host methods;
- requesting tool execution;
- subscribing to allowed events;
- rendering UI in declared slots.

The caller plugin identity is bound by the host factory. Plugins must not pass
or spoof another plugin id.

A JavaScript plugin reaches the bridge through the `PluginHostApi` object it is
handed. Underneath, each member is a JSON-RPC `ave/host/*` request on the
plugin's own stdio, and `schemas/plugin-host-protocol/1/protocol.schema.json`
describes every method, notification and error code of that channel. The file is
generated from the host's own sources at each app release, so it describes what
the host actually serves. To validate a frame, compile a method's `params`,
`result`, `errors` or `events` sub-schema (for example
`#/$defs/methods/ave~1host~1storage~1read/params`), not the method entry, which
groups them under names that are not JSON Schema keywords; with Ajv, set
`allowUnionTypes: true`, because a field that takes more than one type (a
request id, a nullable value) is a type array. The host does not yet admit a
plugin that speaks the protocol without its JavaScript runtime; every plugin
today is a JavaScript `entry`.

## UI Plugins

Plugin UI loads in a host-owned shell. The host resolves the plugin entry URL,
pre-paints theme tokens, and calls the plugin mount function. A plugin UI should
render within the provided root and use the bridge for host interaction.

If the entry cannot load, the shell shows English fallback errors. A blank plugin
surface is considered a regression.

### Panel Width

The host gives the panel the full width of the main pane and does not cap it,
so the plugin owns its own measure. The rules — cap with `max-width` and never
a fixed `width`, the 448px floor, the width tiers, and wide content scrolling
inside its own container — live in [`DESIGN.md`](../../DESIGN.md) under
*Plugin surfaces* and *Responsive behavior*. That document is the source of
truth; this guide does not restate the numbers.

This is the host-mounted **sidebar panel** surface (`ui[]` in the manifest). It is
not the only one: a plugin can also ship an **MCP App** — an interactive `ui://`
card the host renders next to a tool result, built on the standard
`@modelcontextprotocol/ext-apps` library rather than a Ave bridge. See
[Authoring an MCP App](./mcp-app-authoring.md).

## Tool Plugins

Plugin tools are normalized into the host tool registry. A tool definition must
provide:

- name;
- description;
- input schema;
- `_meta.ui.visibility` when the SEP-1865 dual-surface default is not intended;
- `_meta["ave/pathFields"]` where file access is possible;
- execution handler;
- required capabilities.

The Host classifies risk for each invocation. A plugin cannot assign its own
permission category or lower a Host verdict. Tools are executed only after
permission resolution; the plugin runtime does not own the approval gate.

## Settings

Plugins may expose a settings schema. The renderer displays settings through the
host settings UI and persists values through host storage. Secret values should
use secret fields and should not be copied into logs, audit output, or docs.

## Marketplace And Installation

Plugins are published through git marketplaces
([Publishing To A Git Marketplace](./marketplace-publishing.md)). An install
stages the pinned artifact (release, archive or tree), checks the staged
`plugin.json` against the package descriptor, and refuses a manifest that
declares the retired `installPolicy` or `publisher` fields. An installed
manifest that still carries them loads with one warning; its next update
replaces it.

No plugin protects itself. Only the machine's system policy file can keep a
plugin installed: a `marketplaces.requiredInstalls` entry locks the plugin
installed from the source it names against uninstall and disable, and updates
it at boot.

Host secrets beyond the plugin's own namespace come only from the app's
`HOST_SECRET_GRANTS` table (`src/plugins/secret-access/grants.ts`): an official
plugin installed from the artifact its snapshot pins, reading an LLM key its
manifest declares in `hostSecrets.read` for the active vendor. Provider-preset
keys are not in the table, and a local development install never qualifies.

Local development installs (`installLocal`) are for authoring; to test the
marketplace path, serve a repository to a development build
([Testing A Marketplace Locally](./local-marketplace-testing.md)).

## Auth Windows

Plugins that need interactive login should use the host auth-window service.
The host creates the partition, collects cookies or tokens according to policy,
and clears the partition when requested. Plugins must not embed arbitrary auth
flows in renderer code.

## Testing Checklist

Before publishing or merging a plugin change:

- validate `plugin.json` with manifest tests;
- run tool-schema lint where applicable;
- verify settings schema rendering;
- verify install, update and remove from a local git marketplace;
- verify permission prompts for write, shell, network, and out-of-directory
  reads;
- verify plugin UI error fallback and theme token application.

## Language Policy

Default plugin examples, docs, logs, and visible fallback copy should be English.
Korean plugin docs may live under `docs/ko` or plugin-local localization files.
Runtime Korean support should be implemented through locale catalogs or explicit
keyword/intent support, not by making English default docs Korean-only.
