# Extension Development Guide

This guide describes how to build Ave extensions against the current host
runtime. Korean source history is preserved in the
[Korean historical reference](../ko/guides/plugin-development.md).

## Extension Model

An Ave extension is an installable package with a manifest, optional UI bundle,
optional tools, optional settings schema, and declared host capabilities. The
host owns installation, policy, loading, UI containment, and tool execution.

Extensions should add workflow capability without assuming direct filesystem,
network, or process access. Those operations must be declared and routed through
host APIs or tool execution.

## Manifest Basics

Every extension package needs a `plugin.json` manifest. The Host owns the canonical
shape in `schemas/plugin-manifest.schema.json` and the complete TypeScript/JSDoc
authoring contract in `src/plugins/public-contract.ts`. Vendor those two files
and the released host protocol schema `schemas/plugin-host-protocol/3/protocol.schema.json`
unchanged into `contract/` at an app release tag, and record their hashes in
`contract/sources.json`. Published extensions for currently released hosts declare
`extensions["ai.agent-connector.ave"].requires.hostProtocol: "3"` and
`requires.minAppVersion: "0.14.0"`. The retired `@ave/plugin-sdk` package is not a
contract source.

**Upcoming, unreleased:** protocol 4 requires host-validated loopback OAuth state.
This development build serves 4, but released hosts still serve 3. Keep published
packages on protocol 3 until the coordinated release. The future app version is
owned by release preparation; protocol negotiation, rather than a guessed
`minAppVersion`, determines whether a host can run the new contract.

Official extensions live in the official marketplace monorepo
`ken-jo/agent-marketplace` under `plugins/<name>/source/` (hello-world,
local-indexer, meeting); their `src/hostPlugin.ts` files are the
current HostApi usage references. A new extension starts from
`templates/extension/` in that repository. The former per-plugin
repositories and the plugin template repository are archived.

The manifest should include:

- stable extension id;
- display name and version;
- exactly one way to produce its process, `entry` or `process` (below), and
  optional UI declarations;
- pure MCP `Tool[]` objects with colocated input schemas;
- required capabilities;
- settings schema if configurable;
- `requires.minAppVersion`, which a marketplace install requires.

Every extension, JavaScript or `process`, declares `requires.hostProtocol`
(a positive integer written as a string). The host refuses an absent or unserved
version with `incompatible-host-protocol` before activation. A declared minimum
app version cannot make a protocol-3 host serve protocol 4. Known first-release
app floors remain enforced; an unreleased protocol has no numeric floor until
release preparation records the actual first supporting release.

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
extension-owned instruction bundles declared by `manifest.skills`; callable
behavior remains in typed `tools[]`. Skills can guide the model to the relevant
Tool, while the Host's bounded tool catalog and `tool_search` control schema
exposure. The Host does not dispatch or silently preload Tools from keywords.

### `entry` or `process`

An extension declares exactly one of two keys under `extensions["ai.agent-connector.ave"]`.
A manifest with both, or with neither, is rejected.

```jsonc
"entry": "dist/hostPlugin.js"                        // a JS module the host's own runtime loads
"process": {                                         // a program that speaks the extension protocol itself
  "command": "./bin/plugin",
  "args": ["--stdio", "${PLUGIN_ROOT}/vendor"],
  "env": { "PLUGIN_LOG_LEVEL": "info", "PLUGIN_STATE_DIR": "${PLUGIN_DATA}/state" }
}
```

A `process` extension is a program in any language. It reads and writes the
JSON-RPC channel that `schemas/plugin-host-protocol/3/protocol.schema.json`
describes on its own stdin and stdout, starting with `ave/instance/construct`,
whose `entryPath` is the resolved absolute path of `command`. Its rules:

- `command` is a path inside the package, written `./…` or `${PLUGIN_ROOT}/…`,
  naming a regular file. A bare program name (`python`, `node`) is rejected,
  because an extension gets no `PATH` search; so are an absolute path, `..`
  and `=`. Ship the interpreter's launcher in the package, or a script with a
  shebang.
- `args` and `env` values may use two placeholders. `${PLUGIN_ROOT}/…` must
  name a file or directory the package contains, and must not leave the
  package through a symlink. `${PLUGIN_DATA}` and `${PLUGIN_DATA}/…` stay inside
  the extension's data directory, whose leaf may not exist yet, and may not
  pass through a symlink there, even one that points inside it. The data
  directory's parents are host paths and are resolved, links included, but the
  data directory itself must be the real directory Ave created: the extension
  cannot remove or rename it, and one replaced by a link is refused.
  Any other `${…}` is rejected, and so is an argument that looks like a path
  but uses neither placeholder: name it through one of them. Any other `env`
  value is passed to the program as an opaque literal.
- `env` names may not be ones the host reserves, in any letter case:
  `PLUGIN_ROOT` and `PLUGIN_DATA`, which the host sets to the real paths of the
  package and the data directory; loader and interpreter variables such as
  `PATH`, `HOME`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`,
  `BASH_ENV`, `PYTHONPATH`; and launcher, proxy and trust-store prefixes such as
  `NODE_`, `PYTHON`, `UV_`, `PIP_`, `HTTPS_PROXY` and `SSL_CERT_`. Set such a
  variable from your own launcher inside the process instead. The program
  starts from the host's minimal environment, not the user's.
- For released hosts, use `requires.hostProtocol: "3"` and a minimum app
  version of `0.14.0`. The separate process-entry floor remains `0.13.0`.
  Protocol 4 is unreleased and negotiates availability independently of a
  numeric app floor.

Three refusals apply to a `process` extension, each with what to do:

- `process-entry-requires-pinned-artifact`: the extension is installed and run
  only from a marketplace release or archive pinned by its sha256 hash. A
  direct or local development install of one is refused at install, and so is
  a marketplace version that would come from the package's git tree. An
  installed copy without that pin is refused when it starts: remove it, then
  install it from a marketplace that pins its release.
- `MANIFEST_MISMATCH` at a marketplace install: the package's
  `ave-package.json` does not publish the extension the way a `process` entry
  requires. Its `platforms` must be listed without `win32`, its `artifact` must
  pin a `release` or an `archive` by `sha256` and declare no `tree`, and its
  `minAppVersion` must be `0.14.0` or newer for released protocol 3 (above the
  `process` floor of `0.13.0`). The message names the field; the
  marketplace's owner fixes it.
- `process-entry-unconfined`: the program runs only inside the OS Tool Sandbox
  on macOS or Linux. With the sandbox off it is refused, and it cannot run on
  Windows, whose sandbox does not confine the processes a program starts.

## HostApi Boundaries

Extension code receives a host bridge. It must use that bridge for operations such
as:

- reading declared preferences;
- opening approved auth windows;
- calling host methods;
- requesting tool execution;
- subscribing to allowed events;
- rendering UI in declared slots.

The caller extension identity is bound by the host factory. Extensions must not pass
or spoof another extension id.

A JavaScript extension reaches the bridge through the `PluginHostApi` object it is
handed. Underneath, each member is a JSON-RPC `ave/host/*` request on the
extension's own stdio, and `schemas/plugin-host-protocol/3/protocol.schema.json`
(protocol `3`, the released contract) describes every method, notification
and error code of that channel. The file is generated from the host's own sources
at each app release, so it describes what the host actually serves. To validate a frame, compile a method's `params`,
`result`, `errors` or `events` sub-schema (for example
`#/$defs/methods/ave~1host~1storage~1read/params`), not the method entry, which
groups them under names that are not JSON Schema keywords; with Ajv, set
`allowUnionTypes: true`, because a field that takes more than one type (a
request id, a nullable value) is a type array. The host does not yet admit a
extension that speaks the protocol without its JavaScript runtime; every extension
today is a JavaScript `entry`.

Beside the schema, `schemas/plugin-host-protocol/3/protocol-client.ts` is the same
protocol as TypeScript: every named type and every method's params and result,
the `HostMethod`, `InstanceMethod`, `HostNotification` and `HostProtocolErrorCode`
unions, and `createHostClient(transport)`, which has one typed method per
`ave/host/*` request named by its path (`ave/host/storage/read` is
`client.storage.read(params)`). It is generated from the committed schema, imports
nothing and names no app version; pin it by sha256 from the release tag, as you
pin the schema. A JavaScript author who does not use the reference runtime pairs it
with their own stdio loop: implement `HostClientTransport` so that `request`
writes one newline-delimited JSON-RPC request with a fresh `id` to stdout and
resolves with the matching reply's `result` (or rejects with its `error`), and
`notify` writes a frame with no `id`; then, for each line read from stdin, answer
`ave/instance/*` and MCP requests yourself, hand a reply to the pending `request`
with its `id`, and route `isHostNotification(frame)` frames to the plugin. The client does
not validate replies; validate with the schema where you need to.

### Loopback OAuth with PKCE

**Upcoming protocol 4; not available in released protocol-3 hosts.** The example
below targets the unreleased contract. Keep published packages on protocol 3
until the app release ships. For private testing, use a separate unpublished
package with `requires.hostProtocol: "4"` and retain the minimum app version
needed by its existing features; do not infer a new minimum from the candidate
schema path. Protocol-3 packages cannot activate in this protocol-4-only build.

The host owns the redirect listener and its state. `authRedirect.open()` returns
`{ handle, redirectUri, state }`; send that state unchanged, alongside a fresh
PKCE `S256` challenge. Do not mint or encode another state in its place. Public
clients must use PKCE ([RFC 9700 §2.1.1](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1.1));
use the host state as well to prevent
[PKCE downgrade (§4.8)](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.8).
Keep the verifier in the plugin's memory for this attempt and send it only to the
token endpoint when exchanging the validated code.

```ts
import { createHash, randomBytes } from "node:crypto";

const { handle, redirectUri, state } = await api.authRedirect.open();
try {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  // authorizationUrl already contains the provider's client_id, scope and response_type=code.
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  await api.openExternalUrl(authorizationUrl.href);
  const callback = await api.authRedirect.wait({ handle });
  if (callback.error !== undefined || !callback.code) throw new Error("Authorization failed");
  // Exchange callback.code through api.hostFetch with redirect_uri and code_verifier=verifier.
} finally {
  await api.authRedirect.close({ handle });
}
```

The host accepts only its exact path and a single matching state, compared in
constant time using fixed-size digests. Wrong or missing state gets a 4xx without
settling the waiter. The first valid callback consumes the state; replays fail.
`wait()` returns validated parameters, including provider `error` fields, or
rejects on timeout or close. An error response must be handled before any code
exchange. A later `wait()` reads the same validated result, never a new callback.

When protocol 4 ships, re-vendor the public types, manifest schema and protocol
schema/client from that app release tag. Set the manifest and package descriptor
to `hostProtocol: "4"` and the actual first supporting app version, and update each
OAuth library adapter to use the host's state. If a library owns state, use its
supported state option, or exchange the host-validated code directly with the
same attempt's PKCE verifier; never disable host validation.
Protocol-3 packages fail before activation on the protocol-4 build and require
an updated package; released protocol-3 hosts continue to require the old contract.

## UI Extensions

Extension UI loads in a host-owned shell. The host resolves the extension entry URL,
pre-paints theme tokens, and calls the extension mount function. An extension UI should
render within the provided root and use the bridge for host interaction.

If the entry cannot load, the shell shows English fallback errors. A blank extension
surface is considered a regression.

### Panel Width

The host gives the panel the full width of the main pane and does not cap it,
so the extension owns its own measure. The rules — cap with `max-width` and never
a fixed `width`, the 448px floor, the width tiers, and wide content scrolling
inside its own container — live in [`DESIGN.md`](../DESIGN.md) under
*Extension surfaces* and *Responsive behavior*. That document is the source of
truth; this guide does not restate the numbers.

This is the host-mounted **sidebar panel** surface (`ui[]` in the manifest). It is
not the only one: an extension can also ship an **MCP App** — an interactive `ui://`
card the host renders next to a tool result, built on the standard
`@modelcontextprotocol/ext-apps` library rather than an Ave bridge. See
[Authoring an MCP App](./mcp-app-authoring.md).

## Tool Extensions

Extension tools are normalized into the host tool registry. A tool definition must
provide:

- name;
- description;
- input schema;
- `_meta.ui.visibility` when the SEP-1865 dual-surface default is not intended;
- `_meta["ave/pathFields"]` where file access is possible;
- execution handler;
- required capabilities.

The Host classifies risk for each invocation. An extension cannot assign its own
permission category or lower a Host verdict. Tools are executed only after
permission resolution; the extension runtime does not own the approval gate.

## Settings

Extensions may expose a settings schema. The renderer displays settings through the
host settings UI and persists values through host storage. Secret values should
use secret fields and should not be copied into logs, audit output, or docs.

## Marketplace And Installation

Extensions are published through git marketplaces
([Publishing To A Git Marketplace](./marketplace-publishing.md)). An install
stages the pinned artifact (release, archive or tree), checks the staged
`plugin.json` against the package descriptor, and refuses a manifest that
declares the retired `installPolicy` or `publisher` fields. An installed
manifest that still carries them loads with one warning; its next update
replaces it.

No extension protects itself. Only the machine's system policy file can keep a
extension installed: a `marketplaces.requiredInstalls` entry locks the extension
installed from the source it names against uninstall and disable, and updates
it at boot.

Host secrets beyond the extension's own namespace come only from the app's
`HOST_SECRET_GRANTS` table (`src/plugins/secret-access/grants.ts`): an official
extension installed from the artifact its snapshot pins, reading an LLM key its
manifest declares in `hostSecrets.read` for the active vendor. Provider-preset
keys are not in the table, and a local development install never qualifies.

Local development installs (`installLocal`) are for authoring; to test the
marketplace path, serve a repository to a development build
([Testing A Marketplace Locally](./local-marketplace-testing.md)).

## Auth Windows

Extensions that need interactive login should use the host auth-window service.
The host creates the partition, collects cookies or tokens according to policy,
and clears the partition when requested. Extensions must not embed arbitrary auth
flows in renderer code.

### Sign-in compatibility limits

Native WebAuthn credential prompts bypass the window's permission handlers.
Ave does not install a `configureWebAuthn` or account-selection handler, so
macOS platform passkeys and discoverable-credential pickers may not work in
the sign-in window. Try a security key, a phone passkey, or another sign-in
method offered by the site.

Scripted OTP **Paste** buttons that use `navigator.clipboard.readText` are
blocked because the sign-in window denies `clipboard-read`. Paste the code
with **Cmd+V** on macOS or **Ctrl+V** on Windows/Linux instead.

## Testing Checklist

Before publishing or merging an extension change:

- run the plugin validator on the extension directory: `bun run plugin:validate
  <dir>` in this repository, or the vendored `node tools/vendor/ave-plugin-validate.js
  <dir>` in a plugin repository. It checks `plugin.json` against the host's
  manifest schema and protocol rules, drives the extension through the host
  protocol over a real child process (construct, lifecycle hooks, MCP discovery
  and tool calls, stdout discipline, exit on stdin close), and cross-checks event
  and UI-bridge names against the manifest. A `process` extension runs its own
  executable there, unconfined and from your directory, so its report marks
  sandbox confinement and the install's sha256 pin as not exercised (the app
  checks both), and on Windows its protocol step is not run. It prints one
  JSON report row per check to stdout and exits non-zero when a check fails;
  pass `--tool-args <file.json>` for tools whose input requires arguments;
- run tool-schema lint where applicable;
- verify settings schema rendering;
- verify install, update and remove from a local git marketplace;
- verify permission prompts for write, shell, network, and out-of-directory
  reads;
- verify extension UI error fallback and theme token application.

## Language Policy

Default extension examples, docs, logs, and visible fallback copy should be English.
Korean extension docs may live under `docs/ko` or extension-local localization files.
Runtime Korean support should be implemented through locale catalogs or explicit
keyword/intent support, not by making English default docs Korean-only.
