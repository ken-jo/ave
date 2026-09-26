# Extensions and plugins

Status: design, decided by owner direction of 2026-09-27; implementation follows the
slices of §7. This page supersedes
[`../architecture/proposals/plugin-concept-vs-portable-standard.md`](../architecture/proposals/plugin-concept-vs-portable-standard.md)
(2026-08-16), which is kept as provenance and marked superseded.

Anchors: `docs/architecture/architecture.md` (Plugin Runtime, MCP↔plugin execution
parity, OS Execution Sandbox And Plugin Workers),
`docs/design/multi-source-git-marketplace.md` (the catalog, descriptors, content kinds,
revocation; cited below as "marketplace design"),
`docs/design/plugin-hostapi-protocol.md` (the HostApi protocol, Lease and Admission;
cited as "protocol design"), `docs/design/plugin-alerts.md` (the v0.11.0 release).

Every claim about current code names a `file:line` in the ave `f1a8d191e`
checkout (main after the alerts follow-up merged). Claims about the official marketplace
repository name its commit `6a4d3b3df`. The Lease amendment to the protocol design is
being written on another branch (`docs/hostapi-lease-amendment`, one commit ahead of
`f1a8d191e`); where this page depends on it, it says so and names the amendment's
section, and it does not restate the amendment. Claims about other hosts cite their
official documentation (§11) with the access date.

---

## 0. The split in one table

The owner's direction splits today's single "plugin" concept in two:

| | **Extension** | **Plugin** |
|---|---|---|
| What it is | Today's code plugin: `meeting`, `lyra-mail`, `local-indexer`, `vega-helper`, `hello-world`, the `templates/plugin` scaffold, `orion` (`orion-api`), `git` | A standard Agent Plugins 1.0.0 bundle: skills, MCP servers, prompts, agent profiles, routines and hooks, with no Ave runtime code |
| Structural marker | `extensions["ai.agent-connector.ave"].entry` (required today, `schemas/plugin-manifest.schema.json:122-125`, `:135-138`), or the `process` entry the protocol design adds (protocol design §2.1) | no `entry` and no `process` under `extensions["ai.agent-connector.ave"]` |
| Runs | its own confined process speaking `ave/host/*` and MCP (protocol design §2, §3) | nothing of its own. Its MCP servers run as MCP servers do today; its other components are content the host reads |
| Lifecycle gates | Lease and Admission (protocol design §9.1) | the content install path and the per-component consent of §3 |
| Who writes it | a developer against the vendored contract (marketplace design §5.6) | a developer against the public Agent Plugins format, **or** an ordinary user inside the app with no code (§4) |
| Marketplace kind literal | `plugin` (unchanged identifier, §6.2) | `agent-plugin` (new, §5.1) |
| User-facing word | Extension | Plugin |

Existing packages are *offered as extensions*: nothing about them is reinstalled,
re-signed or re-identified (§6.3). The word changes; the identifiers do not.

---

## 1. Definitions and the boundary

### 1.1 Extension

An **extension** is a package whose `plugin.json` carries a runtime entry under the Ave
namespace. Today the namespace block requires `entry` and `tools`
(`schemas/plugin-manifest.schema.json:122-125`), the loader refuses a manifest without
`entry` (`src/plugins/runtime/manifest-validation.ts:821-822`, `:919-923`), and the
protocol design adds `process` as the second form of the same thing (protocol design
§2.1: "exactly one of the two"). The host projects the namespace block onto its internal
manifest with `flattenAgentPluginsManifest` (`src/plugins/public-contract.ts:105-129`),
whose `name` lands on `id`.

An extension is what the protocol design, the Lease amendment and the alerts design
govern: one process per package, `ave/host/*` as its only reach into the host,
`hostFetch` as its only network egress (`src/main/host-fetch-guard.ts:1-24`,
`src/boot/steps/plugin-runtime/host-api-factory.ts:990`, `:1083`), manifest
`capabilities`, `networkAccess`, `hostSecrets`, `pluginAccess`, `alerts`, `sandbox`
authority, install receipts and host-secret grants (marketplace design §10.3).

An extension may still bundle skills, hooks and MCP server configurations through the
contribution declarations that already exist (`schemas/plugin-manifest.schema.json:232-255`;
`src/plugins/plugin-contributions.ts:105-110`). That surface is unchanged by this page:
an extension author who wants those components ships them in the extension.

### 1.2 Plugin

A **plugin** is an Agent Plugins 1.0.0 package (§11, source 1) whose manifest has no
runtime entry. It is a directory the host reads, not a program the host runs:

- `skills/<name>/SKILL.md` — Agent Skills (Agent Plugins §7.1; Agent Skills
  specification, source 2), loaded the way marketplace `skill` packages are loaded today
  (`src/marketplace/content/service.ts:129-131`, `:145-148`;
  `src/main/skill-store.ts:469-486`);
- `mcp.json` — MCP servers (Agent Plugins §7.2), configured through the host's MCP
  manager and governance exactly as an extension-bundled server is
  (`src/mcp/plugin-mcp-projection.ts:23-30`, `:136-150`);
- `ai.agent-connector.ave/prompts/<name>.md` — prompts (§2.2);
- `ai.agent-connector.ave/agents/<name>/AGENTS.md` — sub-agent profiles, the content the `agent`
  kind delivers today (`src/main/agent-profile-store.ts:1-11`);
- `ai.agent-connector.ave/routines.json` — routine templates the user may switch on (§2.2);
- `ai.agent-connector.ave/hooks.json` — declarative hooks in the host's own `hooks.json` format,
  gated as extension-bundled hooks are (`src/hooks/plugin-hook-projection.ts:14-31`);
  a later slice (§7).

The `ai.agent-connector.ave/` directory is the file-based client extension the specification
reserves for a client's own components (Agent Plugins §8.2); the manifest's
`extensions["ai.agent-connector.ave"]` block is its manifest-data half (§8.1). Both are what the
manifest schema already declares as the Ave namespace (`src/plugins/public-contract.ts:47`).

### 1.3 The boundary rule and why one package is never both

**Rule.** A package is an extension if and only if `extensions["ai.agent-connector.ave"]` carries
`entry` or `process`. Everything else that parses as an Agent Plugins manifest is a
plugin. The rule is evaluated from the manifest bytes, never from the marketplace kind,
the source badge, the package name or a user setting; the marketplace kind (§5.1) must
agree with it, and a disagreement is `MANIFEST_MISMATCH` at install (marketplace design
§6.2), the same refusal as a descriptor that disagrees with its `plugin.json`.

**One package is never both.** The manifest schema gains a discriminated shape for the
namespace block (§2.1): the extension branch is today's block, the plugin branch admits
only presentation fields and `requires.minAppVersion`, and a block that carries `entry`
with plugin-only files, or plugin files with no `entry`, is a schema error, not a
package with two natures. Reasons:

1. Two lifecycles. An extension is admitted, leased, spawned, budgeted and retired by
   the protocol machinery; a plugin is installed, activated and revoked by the content
   machinery. A package that is both would need two receipts, two provenance rules and
   two revocation behaviours, and the host would have to decide which one wins when
   they disagree. The protocol design's "data, not code" admission test (protocol design
   §4, "the plugin contributes data and the host contributes code") is exactly the line
   this rule draws at the package level.
2. Nothing is lost. An extension already carries skills, hooks and MCP servers as
   contributions (§1.1). The only thing a plugin has that an extension cannot declare is
   routine templates and prompts, and both are added to the extension contribution set in
   the same slice that adds them to plugins (§7, slice C), so an author never has to
   choose a plugin to get a component.
3. Trust attaches to components (§1.5). Two natures in one package would give the label
   a meaning the consent sheet must then explain away.

### 1.4 How the marketplace and the UI classify

| Surface | Extension | Plugin |
|---|---|---|
| Descriptor / index `kind` | `plugin` (§6.2 keeps the literal) | `agent-plugin` (§5.1) |
| Conventional layout directory (marketplace design §3.3) | `plugins/` | `agent-plugins/` |
| Direct install detection (marketplace design §8.1; `src/marketplace/sources/direct-package.ts:25`) | `plugin.json` with `entry` or `process` → `kind: "plugin"` as today | `plugin.json` without either → `kind: "agent-plugin"`; today's refusal of a manifest without the namespace block (`direct-package.ts:112`) becomes "no namespace block or no entry → plugin" |
| Kind tab label (`src/ui/renderer/tabs/git-marketplace/labels.ts:17-31`; `src/i18n/messages/generated/gitMarketplace.ts:30-38`) | "Extensions" | "Plugins" |
| Sidebar group (`src/ui/renderer/components/Sidebar.tsx:406-407`, `:2420-2421`; `src/i18n/messages/generated/sidebar.ts:6`) | "Extensions" (installed extension rows and their UI slots) | none: a plugin has no UI slot |
| Settings groups and tabs (`src/i18n/messages/generated/settingsContent.ts:16`, `:18`, `:24`) | "Extensions", "Extension settings", "Extension performance" | plugins appear in the Marketplace tab's Installed view and in the surfaces their components already have (skills in the slash picker, MCP servers in MCP settings, routines in the Routines panel) |
| Package sheet (marketplace design §15.2) | Permissions from `PluginAuthority`, Delivery rungs | **Components** from the descriptor's component summary (§5.2): each component with its trust class (§1.5) |
| Doctor, plugin-status, alerts source labels | say "extension" | not applicable |

### 1.5 Trust is decided per component and capability, never by the label

The label "plugin" grants nothing and the label "extension" costs nothing. What decides
trust is what a component *is*:

| Component | Class | What decides, and where it already exists |
|---|---|---|
| Skill (`SKILL.md`, `references/`, `assets/`) | instructions the model may load | the `skill_load` tool's approval gate (`src/tools/skill-load.ts:118-121`, `:208-222`) and the skill content limits (`src/marketplace/content/rules.ts:48-52`). A skill's `scripts/` are never executed by the loader; the model may run them only through the shell tool under the normal permission path, and the review sheet flags a skill that ships `scripts/` |
| MCP server (`mcp.json`) | **code that spawns a process** (stdio) or a network peer (streamable HTTP) | governance Layer 1, deny by default (`src/mcp/mcp-governance.ts:77`, `:168-178`); an exact-fingerprint approval that never transfers to another version (`src/plugins/plugin-contribution-trust.ts:5`, `:30-31`; `src/mcp/plugin-mcp-projection.ts:23-30`); the ASRT wrap when the sandbox is on, fail-closed (`src/mcp/mcp-client.ts:2156-2172`); tool trust tier `low` like every MCP server (`src/tools/types.ts:83-90`; `src/mcp/mcp-tool-adapter.ts:24-27`). §3.2 |
| Hook (`ai.agent-connector.ave/hooks.json`) | a command the host runs on its own events | the `hooks.json` trust unit and lockfile (`src/hooks/hook-config-trust.ts:1-22`), the exact-generation approval for bundled hooks (`src/hooks/plugin-hook-projection.ts:14-31`), the closed event set (`src/hooks/script-hook-types.ts:56`, `:74-86`), the per-entry timeout and output caps (`:261`, `:264`). §3.3 |
| Routine template (`ai.agent-connector.ave/routines.json`) | an unattended turn the host would start on a schedule | installed **disabled**; switching one on creates a `RoutineRecord` through the routines store with its caps (`src/main/routines-store.ts:374-386`; `src/shared/routines-types.ts:14`, `:21`) and a scope that defaults to deny-all (`src/shared/routines-types.ts:100-108`). §3.4 |
| Prompt (`ai.agent-connector.ave/prompts/*.md`) | text the user chooses to send, written by someone else | a user click in the slash picker, a non-keyboard provenance origin (the shape MCP prompts use, `src/shared/chat-origin.ts:17-24`; `src/ui/renderer/components/slash-picker-data.ts:18-30`), and the leading-slash strip (`src/shared/slash-sanitizer.ts:7-15`). §3.5 |
| Agent profile (`ai.agent-connector.ave/agents/`) | a sub-agent prompt | the same store and `agent_spawn` path as the `agent` kind (`src/main/agent-profile-store.ts:1-11`) |
| Extension code (`entry` / `process`) | a process with a HostApi connection | Lease, Admission, receipts, manifest authority (protocol design §7; marketplace design §10) |

An MCP server inside a plugin is therefore exactly as trusted as the same server added
by hand or bundled by an extension: it is a process, it gets the process controls, and
the word on the tab does not move it.

---

## 2. The plugin format

### 2.1 Alignment with Agent Plugins 1.0.0

The manifest schema already is an Agent Plugins document: the top level is the
specification's closed ten-key object with `$schema` fixed to
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`
(`src/plugins/public-contract.ts:38-39`; the schema's top-level `required` is
`$schema`, `name`, `version`, `description`, `extensions` with
`additionalProperties: false`), and everything Ave-specific sits under
`extensions["ai.agent-connector.ave"]` (`:47`). Plugins use the same file, the same top level and
the same namespace. What changes:

1. **The namespace block becomes a discriminated shape.** `extensions["ai.agent-connector.ave"]`
   is `oneOf`:
   - the **extension branch**: today's block, `required: ["entry", "tools"]`
     (`schemas/plugin-manifest.schema.json:122-125`), unchanged;
   - the **plugin branch**: `additionalProperties: false` over `displayName`, `icon`,
     `iconText`, `requires: { minAppVersion }` and `mcpAuth` (§3.2). No `entry`, no
     `tools`, no capability, network, secret, access, alert, UI or sandbox field: a
     plugin has nothing those fields would govern.
   - The block is optional for a plugin; a plugin with no Ave-specific data has no
     block at all, which is what a portable package written for another host looks like.
   A manifest whose block matches neither branch is refused by the schema with the
   branch mismatch named, before any file under the package is read.
2. **Fixed component locations, no declarations.** Skills are discovered at `skills/`
   and MCP servers at `mcp.json` as the specification fixes them (Agent Plugins §6, §7);
   Ave components are discovered at fixed paths under `ai.agent-connector.ave/` (§1.2). The
   extension branch's `skills`/`hooks`/`mcpServers` declaration arrays
   (`src/plugins/public-contract.ts:761-764`) are not used by plugins: the specification
   already fixes the portable locations, and a declaration that could disagree with a
   fixed location is a second source of truth.
3. **Unknown top-level fields are reported and ignored; unknown `extensions`
   namespaces are ignored without validation** (Agent Plugins §5.2, §8.1, §11.3). This
   is what lets the same directory carry `extensions["com.example.other"]` for another
   host. The host writes one diagnostic per unknown field per load, as the protocol
   design applies the same rule to the wire (protocol design §3.3).
4. **`${PLUGIN_ROOT}` and `${PLUGIN_DATA}`** are expanded in `mcp.json` `args`, `env`
   and `cwd` and set in the server's environment (Agent Plugins §9). `PLUGIN_DATA` is
   the package's data directory, kept across updates and removed at uninstall only when
   the user chooses to remove data — the rule the `mcp` kind already has for `$DATA_DIR`
   (marketplace design §5.2; `src/marketplace/app/mcp-installer.ts:1-18`). A server
   whose `env` names `PLUGIN_ROOT` or `PLUGIN_DATA` is invalid (Agent Plugins §9.2).

Portability follows: a package with only `plugin.json`, `skills/` and `mcp.json` loads
in Ave and in any other conformant client unchanged; a package with `ai.agent-connector.ave/` loads
elsewhere with that directory ignored; a package written for another client with its
own namespace loads in Ave with that namespace ignored.

### 2.2 Components supported at launch

| Component | Location | Format | Supported from |
|---|---|---|---|
| Skills | `skills/<name>/SKILL.md` | Agent Skills frontmatter `name`, `description`, optional `license`, `compatibility`, `metadata`, `allowed-tools` (source 2); the host's skill content rules apply per skill (`src/marketplace/content/rules.ts:48-52`) | slice C |
| MCP servers | `mcp.json` | Agent Plugins `mcp.schema.json` (`mcpServers` map; `type: "stdio"` with `command`, `args`, `env`, `cwd`; `type: "http"` with `url`), constrained by the host's launcher grammar (§3.2) | slice C |
| Prompts | `ai.agent-connector.ave/prompts/<name>.md` | frontmatter `name` (`^[a-z][a-z0-9-]{0,62}$`), `description`, `kind: "template" \| "persona"`, optional `argumentHint`; body ≤ 8 KiB, the persona body limit (`src/main/persona-prompt-store.ts:19`). A **template** is a slash-picker entry that sends its body as one message with `{args}` replaced by the user's text; a **persona** is a system-prompt addition selectable per turn, the store that exists today (`src/main/persona-prompt-store.ts:1-8`) | slice C |
| Agent profiles | `ai.agent-connector.ave/agents/<name>/AGENTS.md` | the `agent` kind's file (marketplace design §5.2) | slice C |
| Routine templates | `ai.agent-connector.ave/routines.json` | `{ "version": 1, "routines": [{ id, title, trigger: "schedule" \| "shutdown", schedule?, execution: "llm-session" \| "notification-only", prePrompt?, notificationTitle?, notificationBody?, scope?: { pluginIds } }] }` — the `AddRoutineInput` fields (`src/shared/routines-types.ts:147-170`) minus anything runtime-owned, with `id` matching `^[a-z][a-z0-9-]{0,62}$` and at most 8 templates | slice C |
| Hooks | `ai.agent-connector.ave/hooks.json` | the host's `hooks.json` shape (`src/hooks/hook-config.ts:49-70`): event keys from the closed set (`:91-110`), `command` in argv form only, optional `matcher`, `timeoutMs` clamped to `DEFAULT_HOOK_TIMEOUT_MS` (`src/hooks/script-hook-types.ts:261`) | slice E |

Everything else a package may contain is ignored with a diagnostic, never executed
(Agent Plugins §11.3). The rejections that are explicit because an author will look for
them:

| Not supported | Why |
|---|---|
| language-server declarations, output styles, workflows, monitors, `bin/` executables, plugin `settings.json`, `user_config` | Ave has no feature they would attach to; `bin/` and `user_config` would add an ambient executable path and a secret channel outside the host's stores. Ignored with a diagnostic naming the file |
| themes inside a plugin | themes are their own kind with their own token contract (marketplace design §5.5); a theme travels as a `theme` package |
| a second manifest location (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) | the loader reads the specification's root `plugin.json` only (Agent Plugins §5.1). A package that has only a client-specific manifest is handled by the importer (§2.4), which produces a root manifest the user reviews |
| hook types other than `command` (HTTP, MCP-tool, prompt, agent hooks) | the host's hook runner spawns argv (`src/hooks/hook-config.ts:64-66`); the other types would each be a new network or model surface. Rejected by name in the hooks parse diagnostics |
| `sse` MCP transport, `{variable}` templates, registry base URLs, extra launcher options | the same refusals the `mcp` kind makes (marketplace design §5.2) |

### 2.3 How hooks and commands map onto Ave features

A **command** in other hosts is a Markdown file whose body is sent as the user's message
when invoked by name. Ave has that feature already for MCP prompts: a user-controlled,
never model-callable slash-picker entry whose text enters the turn with non-keyboard
provenance (`src/ui/renderer/components/slash-picker-data.ts:18-30`;
`src/shared/chat-origin.ts:17-24`). A plugin **template prompt** (§2.2) is the same
feature with a package instead of a server as the author. The mapping the importer
(§2.4) applies:

| Source field | Template prompt |
|---|---|
| file name `commands/<name>.md` | `ai.agent-connector.ave/prompts/<name>.md`, `kind: template` |
| frontmatter `description`, `argument-hint` | `description`, `argumentHint` |
| body `$ARGUMENTS` | `{args}` |
| frontmatter `allowed-tools`, `model`, `disable-model-invocation` and any other key | dropped, one diagnostic each: Ave decides tool permission per invocation and never lets a prompt pre-approve a tool |
| a body that begins with `/` | the leading slash is stripped at send (`src/shared/slash-sanitizer.ts:7-15`); a template cannot dispatch a host slash command |

A **hook** in other hosts is a command (or another handler type) run on a lifecycle
event. Ave's hook system has a closed event set and a declarative `hooks.json`
(`src/hooks/hook-config.ts:91-110`). The mapping:

| Source event | Ave event (`hook-config.ts:91-110`) |
|---|---|
| `PreToolUse`, `PostToolUse`, `PermissionRequest` | `pre`, `post`, `perm` |
| `UserPromptSubmit` | `UserPromptSubmit` (blocking, fail-closed, `script-hook-types.ts:92`) |
| `PostToolUseFailure`, `PermissionDenied`, `SessionStart`, `SessionEnd`, `Notification`, `Stop`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop` | the same names (observe-only) |
| any other event | rejected by name; the hook entry is dropped and the diagnostic says the event has no Ave equivalent |
| handler `type: "command"` in exec form (`command` + `args`) | `command: [command, ...args]` |
| handler `type: "command"` in shell form (one string) | rejected: the host runs argv, never a shell string, so the entry must be rewritten in exec form; the diagnostic names the entry |
| `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` in `command`, `args`, `env` | `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`, the Agent Plugins placeholders (§9.2) |
| `${user_config.*}` | rejected: no secret or setting channel outside the host's stores |
| handler `type` other than `command` | rejected (§2.2) |

Hooks in plugins ship in slice E (§7), after the components that need no host command
execution; until then a `ai.agent-connector.ave/hooks.json` in an installed plugin is listed in the
package sheet as "not loaded on this app version" with the version that loads it. That
is a declared unsupported component (Agent Plugins §11.3), not a fallback.

### 2.4 Import and export

**Import** takes a package written for another host and produces an Ave plugin the user
reviews before anything is installed. It is a studio operation (§4), never a silent part
of install, because the transformation drops and rewrites fields and the user must see
what survived.

Inputs and detection, in order at the given path:

1. root `plugin.json` with `$schema` — an Agent Plugins package: read as is; a
   `skills/`, `mcp.json` and, if present, `commands/`, `hooks/hooks.json`, `.mcp.json`
   and `agents/` are mapped per §2.3 and the tables below;
2. `.claude-plugin/plugin.json` and no root manifest — the Claude Code layout (source 3):
   the importer writes a root manifest (`$schema`, `name`, `version`, `description`,
   `author`, `homepage`, `repository`, `license`, `keywords` copied; every other key
   dropped with a diagnostic), maps `skills/` (or a root `SKILL.md`, which that layout
   treats as a single skill) to `skills/`, `commands/*.md` to template prompts,
   `agents/*.md` to `ai.agent-connector.ave/agents/<name>/AGENTS.md`, `.mcp.json` to `mcp.json`
   (`mcpServers` map; `command`/`args`/`env`/`url` kept; `${CLAUDE_PLUGIN_ROOT}` and
   `${CLAUDE_PLUGIN_DATA}` rewritten; a `headers` or `oauth` block dropped with a
   diagnostic), and `hooks/hooks.json` per §2.3;
3. `.codex-plugin/plugin.json` and no root manifest — the Codex compatibility overlay
   (source 5): the same as 2 for the manifest; that host's own `hooks/` directory is not
   read (see UNVERIFIED);
4. otherwise the input is not a plugin; the studio says which files it looked for.

The importer never fetches anything the package references, never runs a script, and
writes only under the studio's draft directory (§4.3). Its result is a draft with a
diagnostics list; the user installs it through the ordinary review sheet.

**Export** writes an Agent Plugins directory from an installed or drafted plugin:
`plugin.json`, `skills/`, `mcp.json`, `ai.agent-connector.ave/`, plus a `ave-package.json`
descriptor (§5.2) and `LICENSE` if the author set one. Two optional projections for
other hosts are written next to the portable files, never instead of them:

- **Claude Code projection**: `.claude-plugin/plugin.json` (`name`, `version`,
  `description`, `author`), `commands/<name>.md` for each template prompt (`{args}` →
  `$ARGUMENTS`), `agents/<name>.md`, `.mcp.json` from `mcp.json` (placeholders
  rewritten), `hooks/hooks.json` from `ai.agent-connector.ave/hooks.json` with the event names
  mapped back;
- **Codex**: nothing extra; that host reads the portable root manifest, `skills/` and
  `mcp.json` (source 5).

Routines and persona prompts have no equivalent elsewhere and stay under `ai.agent-connector.ave/`.
Secrets are never exported (§3.2): a server whose `mcpAuth` names a key is exported with
the declaration and without the value.

---

## 3. Trust, consent and sandbox for plugins

### 3.1 What a plugin can never do

A plugin has no HostApi connection: no `ave/host/*` method, no `hostFetch`, no
`callLlm`, no `getSecret`, no `resolveApiKey`, no worker, no window, no UI slot, no
alert kind, no work proposal, no `pluginAccess`, no `networkAccess`, no `hostSecrets`, no
`sandbox` grant. None of those fields exists in the plugin branch of the schema (§2.1),
so nothing in a plugin can ask for them, and there is no code plugin process in which
they could be exercised. Lease and Admission therefore do not apply to a plugin,
because there is nothing to lease and nothing to admit; a plugin cannot obtain a lease
by any path, and a plugin's MCP server is not a `ave/host/*` peer (§3.2). This page
adds no member, channel or capability to the HostApi and no consumer of it.

The only process a plugin can cause to run is an MCP server, and it runs under the MCP
controls that exist for every MCP server. The only unattended turn a plugin can cause
is a routine the user switched on. Everything else a plugin contains is text the host
reads.

### 3.2 MCP servers

**Admission.** Each `mcp.json` entry is projected the way an extension-bundled server
is projected today (`src/mcp/plugin-mcp-projection.ts:136-150`): a server id
`plugin_<hash>` derived from the package name, version, local id and fingerprint; an
approval with `allowedCommands: [command]` (stdio) or `allowedUrls: [hostname]` (http),
`allowedCapabilities: ["tools"]`, `maxTools: 64`, `toolPermissionMode: "strict"`, a tool
name prefix derived from the package; and `registerRuntimeApproval` while the plugin is
enabled (`src/mcp/mcp-governance.ts:405-414`). The runtime approval is registered only
after the user has approved that exact fingerprint in the package sheet, recorded in
the `mcpServer` trust store whose records never transfer across versions
(`src/plugins/plugin-contribution-trust.ts:5`, `:30-31`); an update re-asks. A managed
policy entry with the same id refuses the runtime approval (`mcp-governance.ts:405-408`),
and the global server cap counts runtime approvals (`:187`). Governance is asked again at
connect (`validateServer`, `:168-178`), as it is for a marketplace `mcp` install
(`src/marketplace/app/mcp-installer.ts:194-197`, `PACKAGE_POLICY_BLOCKED`).

**Organization switch.** `globalRules.allowUserApprovedServers: boolean` is added to the
governance policy file (`src/mcp/mcp-governance.ts:77-84` holds `globalRules`), default
`true`. When an organization sets it `false`, `registerRuntimeApproval` refuses with a
message naming the rule, for plugin-bundled and extension-bundled servers alike, and only
servers the policy file lists as approved connect. This exists so that "a user approved
it" is a decision the machine's administrator can switch off; today the runtime path
has no such switch, and the extension path inherits the same one.

**Launcher grammar.** A stdio `command` must be one of: `npx`, `uvx` or `docker` with the
pinned forms of the marketplace design (§5.2: exact version, no registry option, tagged
or digested image); `node` or `bun` whose first argument is `${PLUGIN_ROOT}/<path>` to a
file inside the package; or `${PLUGIN_ROOT}/<path>` naming an executable inside the
package, the form the `mcp` kind's `server/` directory already admits (marketplace design
§5.2, "a package-local command runs from the package's `server/` directory"). Any other
command, a bare `python`, a path outside the package, `..`, `\`, `:` or a control
character is refused with the entry named. `env` keys and values follow the reserved-name
rules of `src/mcp/safe-names.ts` and the launcher-variable exclusions of the marketplace
design (§5.2); `env` values are visible package data and may not carry a secret
(Agent Plugins §9.2).

**Secrets.** `mcp.json` has no secret field by design. A plugin whose server needs a
credential declares it in the manifest's plugin branch:

```jsonc
"extensions": { "ai.agent-connector.ave": {
  "mcpAuth": { "<serverName>": { "auth": "api-key", "apiKeyEnv": "EXAMPLE_TOKEN" } }   // or apiKeyHeader for http
} }
```

The declaration is the `auth`/`apiKeyEnv`/`apiKeyHeader` triple `McpRuntimeSpec` already
carries (`src/plugins/mcp-runtime-spec.ts:34-75`), so the value is entered by the user in
MCP settings, stored in the host's encrypted secret store and injected at spawn by the
MCP client (`src/mcp/mcp-client.ts:2141-2145`), exactly as for a marketplace `mcp`
package. A server named in `mcpAuth` that is not in `mcp.json`, or a second secret for
one server, is a schema error.

**Sandbox and egress.** A plugin's stdio server is spawned by the MCP client: with the
OS sandbox on it is wrapped by ASRT and fails closed if the wrap cannot be produced
(`src/mcp/mcp-client.ts:2156-2172`), with the centralized sensitive read and write deny
lists (`:2236-2249`); with the sandbox off it is a plain spawn (`:2176`), which is the
confinement class every MCP server and every extension child has with the sandbox off
(protocol design §13, decision 3). Its network egress is the sandbox's shared egress
allow-list when wrapped and unconstrained when not; an http server's URL is held to the
approval's hostname, HTTPS and the private-network guard (`mcp-governance.ts:200-225`).
`hostFetch` and its Tier A rules do not apply, because an MCP server is not a HostApi
peer and has no lease; that is not a weaker path but a different one, and the package
sheet states which confinement the server will run under, as the Doctor states it for
extensions (protocol design §13, decision 3).

**Trust tier.** `low`, like every MCP server (`src/tools/types.ts:83-90`;
`docs/architecture/architecture.md:1054-1057`). The plugin label does not raise it, and
the parity invariant (`architecture.md:1044-1060`) is untouched: the tools register
through the same adapter and execute through the same `ToolExecutor` stages.

### 3.3 Hooks

A plugin hook is loaded only through the path extension-bundled hooks use: parse
(`src/hooks/hook-config.ts:49-70`), anchor every command token to the package root
(`src/plugins/plugin-bundled-command.ts:20-26`), fingerprint, and require an exact
approval from the `hook` trust store (`src/hooks/plugin-hook-projection.ts:14-31`) that
does not survive a version change. The consent sheet shows the argv verbatim. At run
time the entry runs with the runner's timeout and output caps
(`src/hooks/script-hook-types.ts:261`, `:264`) and a DLP-redacted stdin envelope. A
`command[0]` outside `${PLUGIN_ROOT}` is refused unless it is `node` or `bun` with a
`${PLUGIN_ROOT}` script (the same list as §3.2), so an installed plugin can never turn an
arbitrary host binary into a hook.

### 3.4 Routines

A routine template is inert until the user switches it on in the Routines panel, where
it appears under the plugin's name with its schedule and, for `llm-session`, its full
`prePrompt`. Switching it on calls the routines store's `add` with
`source: "plugin:<packageName>:<templateId>"` (the existing idempotency identity field,
`src/shared/routines-types.ts:139-145`; `MAX_ROUTINE_SOURCE_LENGTH` applies) and is
refused when the persisted or LLM-session cap is reached
(`src/main/routines-store.ts:374-386`). The scope is what the template names, filtered
to installed extension ids the user confirms in the same dialog; a template with no
scope gets `{ pluginIds: { mode: "deny-all" } }` (`src/shared/routines-types.ts:100-108`).
Uninstalling or disabling the plugin dismisses every routine whose `source` names it.
A routine template never runs by being installed: installation is not consent to an
unattended turn.

### 3.5 Prompts and skills

A template prompt is sent only by a user click, under a new `ChatInputOrigin` value
`plugin-prompt-emitted` beside `mcp-prompt-emitted` (`src/shared/chat-origin.ts:24`),
with the same consequences: never `user-keyboard`, tool calls in that turn carry
non-user provenance, and the leading-slash strip applies (`src/shared/slash-sanitizer.ts:7-15`).
Adding the enum value is a shared field-addition sweep (AGENTS.md, "A shared payload
field or enum literal requires a same-PR field-addition sweep"). A persona prompt lands
in the persona store's package layer, selected per turn as today's personas are.

A skill enters a turn only through `skill_load` and its approval gate
(`src/tools/skill-load.ts:208-222`); the package layer of the skill store makes a
plugin's skills visible without copying them into `~/.ave/skills/`
(`src/main/skill-store.ts:469-486`), so uninstalling the plugin removes them.

---

## 4. No-code creation

### 4.1 What a user composes

A user builds a plugin from things the app already has, plus text the assistant helps
write:

| Part | Source in the app | What goes into the package |
|---|---|---|
| Skill | an installed skill (marketplace package or `~/.ave/skills/`), or a new one written in conversation | a copy of the skill directory (without `scripts/` for a studio-authored skill; an existing skill's `scripts/` are copied and flagged) |
| Routine | an existing routine from the Routines panel, or a new schedule described in conversation | a template with the routine's schedule, execution, prompt and scope, minus run history |
| Connector | an MCP server already configured in MCP settings (hand-added, marketplace-installed, or from another plugin) | its runtime spec (`command`/`args`/`env` or `url`) as an `mcp.json` entry and, if it has a key, an `mcpAuth` declaration; **never the key value** |
| Prompt | a persona from `~/.ave/prompts/`, or a template written in conversation | `ai.agent-connector.ave/prompts/<name>.md` |
| Agent profile | a profile from `~/.ave/agents/` | `ai.agent-connector.ave/agents/<name>/AGENTS.md` |

Not composable in the studio: extension code, hooks, `scripts/` for new skills,
executables. A user who needs those writes a package by hand or asks a developer; the
studio says so instead of offering a degraded version.

### 4.2 The creation UX: conversation and forms

Two entry points produce the same draft:

- **Form.** Settings → Marketplace → Plugins → *Create a plugin*: name, description,
  then a checklist of installed skills, routines, connectors, prompts and profiles to
  include, then a review page that shows every file the package will contain.
- **Conversation.** The user asks the assistant ("make me a plugin that prepares my
  Monday summary from my calendar and mail"). The assistant uses three built-in tools:
  `plugin_studio_draft` (create or update a draft: name, description, the parts to
  include by reference, and authored text for new skills, prompts and routine
  templates), `plugin_studio_read` (read a draft back), and `plugin_studio_validate`
  (run §4.4 and return diagnostics). They are `source: "builtin"` tools with the
  `meta` category, approval-gated like `skill_load`, model-visible, and they write only
  under the draft directory (§4.3). They never install, publish, export, or read a
  secret. The conversation ends at the same review page as the form.

Nothing is installed until the user presses *Install* on the review page, which opens
the ordinary package sheet for a local package (§4.3), with the per-component consent of
§3. The assistant cannot press it.

### 4.3 Where the result is stored

```
~/.ave/studio/                     # openFeatureNamespace("studio"): 0o700 / 0o600
  <name>/
    package/                        # the Agent Plugins directory (§2)
    draft.json                      # { version: 1, name, createdAt, updatedAt,
                                    #   parts: [{ path, origin }], reviewedAt?, sharedAt? }
```

`parts[].origin` records where each file came from: `{ kind: "copied", from: { kind,
name, version } }` for a copied installed package, `{ kind: "user-store", path }` for a
user skill, prompt or profile, `{ kind: "conversation", sessionId }` for text the
assistant authored, `{ kind: "typed" }` for the form. The origin is also written into
the file where the format has a place for it: `SKILL.md` `metadata` (a string map,
Agent Skills §frontmatter) gets `ave-origin: studio` and `ave-authored-by: model |
user`; a prompt's frontmatter gets the same two keys.

Installing a draft copies `package/` through the content install path as a package
bound to no source, the way a pasted MCP server is recorded with `origin: null`
(`src/marketplace/app/mcp-installer.ts:320-326`; marketplace design §13.1). It lands in
`packages/agent-plugin/<name>/<version>/` with a ledger entry whose origin has
`sourceId: null` and the tree digest, and it shows in the Installed view as "created
here — no updates". Editing the draft and installing again is an update of that package
(same name, higher version required, the strict-increase rule of marketplace design §4.2).

### 4.4 Validation

The draft runs the same rules a marketplace repository runs before it publishes
(`src/marketplace/repository-check.ts:1-16`: the catalog validators, the content parsers,
the MCP launcher grammar, the content file rules), extended for the new kind (§5.2), plus
studio rules:

- the manifest name is a package name (`src/marketplace/catalog/types.ts:26`);
- every skill parses under the Agent Skills frontmatter rules and the skill content
  limits; a studio-authored skill has no `scripts/`;
- every prompt body is within the persona limit and, for a template, names each `{args}`
  it uses;
- every routine template is a valid `AddRoutineInput` and its schedule parses
  (`src/main/routines-store.ts:52-58` bounds; `isValidCronExpression`);
- every `mcp.json` entry passes the launcher grammar and reserved-name rules (§3.2), and
  `mcpAuth` names only servers that exist;
- the advisory injection lint (§4.6) has run and its findings are attached.

A draft with an error cannot be installed or shared; a draft with warnings can, after
the user has seen them.

### 4.5 Sharing

Three ways, all starting from the review page's *Share*:

1. **Export a file.** `<name>-<version>.zip` of the package directory plus its
   `ave-package.json`. Another user installs it through Settings → Marketplace →
   *Install from file*, which opens the same package sheet as a marketplace install with
   the file's contents as the descriptor and every component's consent (§3). The
   install is bound to no source and never updates.
2. **Publish to a git marketplace.** The studio writes the package as
   `agent-plugins/<name>/` (package directory plus descriptor) into a local checkout the
   user picks, and shows the exact next steps: run the repository's checker, commit,
   open a pull request. The app does not commit or push: the marketplace's git contract
   is read-only by design (marketplace design §9.3 lists the commands it uses and nothing
   else), pushing would need write credentials and branch rules the app should not hold,
   and a merge to `main` is the publish (marketplace design §4.3). The official
   repository's index generator learns the new kind (§7, monorepo).
3. **Share inside a team.** A team's marketplace is a custom or managed source
   (marketplace design §12, `additional`); publishing to it is case 2. There is no
   in-app team channel: the agent-hub is decommissioned and the app has no server.

A shared package carries its `draft.json` provenance only inside the files where §4.3
put it; the draft directory itself is never exported.

### 4.6 Safety: model-authored content, prompt injection, and consent

The threat is a plugin whose text steers the model against the user who installs it:
a skill that says to read `~/.ave/secrets`, a routine prompt that asks to mail a
document somewhere, a template that starts with a host command. The controls, in the
order they apply:

1. **Nothing in a plugin can grant itself anything.** A skill is instructions inside a
   turn whose tools still pass Layer-1 deny, the ApprovalGate and audit
   (`architecture.md:1049-1053`); a routine runs under the routine policy lane with its
   scope; an MCP server is `low` trust; a prompt is non-keyboard provenance. The
   security control is the permission system, not the text review.
2. **Provenance is recorded** (§4.3): the review sheet says which parts were written by
   the model, which were copied from an installed package (with its version), and which
   the user typed.
3. **The author reviews before sharing.** *Share* shows every skill, prompt and routine
   template in full, with the advisory lint findings, and requires the author to confirm
   they read them; `draft.json.reviewedAt` is set and export refuses without it.
4. **The installer reviews before installing.** The package sheet shows the same full
   texts (not summaries), each MCP command and each hook argv verbatim, and asks for each
   code-executing component separately; routines are installed disabled (§3.4).
5. **An advisory lint** runs over skills, prompts and routine prompts and flags, with the
   matched text: instructions to ignore or override prior instructions; requests to read
   `~/.ave`, `~/.ssh`, `~/.aws` or the secret store; requests to disable approvals,
   sandboxes or hooks; instructions to send content to a URL or address that the plugin
   does not otherwise name; a template body beginning with `/`. It is a warning surface
   for the two human reviews above, stated as such in the UI; it is not a gate and not a
   security control, because a heuristic that can be phrased around must not be
   presented as one.
6. **Revocation reaches shared packages** through the source that published them
   (§5.5); a file-shared package is revoked by the user who installed it.

---

## 5. The marketplace and catalog

### 5.1 Kinds and listing vocabulary

`PACKAGE_KINDS` (`src/marketplace/catalog/types.ts:12-22`) gains `agent-plugin`. The
existing literal `plugin` keeps its value and its meaning (a code package); only its label
changes (§6.1). The kind tab order (`labels.ts:17`) becomes Plugins (`agent-plugin`),
Extensions (`plugin`), MCP, Skills, Agents, Themes, Fonts, Languages, Providers,
Messaging: the kind an ordinary user is meant to find first is first. The conventional
layout scans `agent-plugins/` beside `plugins/` (marketplace design §3.3); a descriptor
under `plugins/` that declares `agent-plugin`, or the reverse, is dropped with a
diagnostic like any directory–kind mismatch. The deep-link forms
`ave://install/<kind>/<name>@<source>` (`src/main/ave-protocol.ts:14`;
`src/shared/git-marketplace.ts:334`) and the policy lists
(`src/marketplace/sources/policy.ts:16`, `:38`) accept the new literal through
`isPackageKind` (`src/shared/git-marketplace.ts:445`).

The literal is `agent-plugin` and not `plugin`, `bundle` or `kit` because it names the
specification the package conforms to and reads correctly in every place a kind literal
appears (a directory name, a ledger row, a deep link, a policy entry), while leaving the
existing literal untouched (§6.2).

### 5.2 Descriptor and index changes

The descriptor for the new kind:

```ts
// ave-package.json, kind "agent-plugin"
payload: {
  manifest: "plugin.json";                 // fixed
  components: AgentPluginComponents;       // copied from the package; the catalog reads it without downloading bytes
}

interface AgentPluginComponents {
  skills: Array<{ name: string; hasScripts: boolean }>;
  mcpServers: Record<string, McpServerSpec>;          // marketplace design §5.2 shape, after placeholder normalization
  mcpAuth?: Record<string, { auth: "api-key"; apiKeyEnv?: string; apiKeyHeader?: string }>;
  prompts: Array<{ name: string; kind: "template" | "persona" }>;
  agents: string[];
  routines: Array<{ id: string; execution: "llm-session" | "notification-only"; repeat: string }>;
  hooks: Array<{ event: string; command: string[] }>;
}
```

`components` plays the role `PluginAuthority` plays for extensions (marketplace design
§5.2): the index copies it into each `IndexVersion`, the package sheet renders it before
any download, the update review shows its delta (a new MCP server or hook is highlighted
like a new capability, marketplace design §15.6), and install compares it with the
staged package field by field; a difference is `MANIFEST_MISMATCH` (marketplace design
§6.2). The repository check enforces the same comparison in CI.

Content rules for the kind (`src/marketplace/content/rules.ts:48-101` gains a row):
8 MB total, 256 files; per-file rules are the union of the skill rules for `skills/**`,
`.json` and `.md` at the root and under `ai.agent-connector.ave/`, `AGENTS.md` under
`ai.agent-connector.ave/agents/`, and the `mcp` kind's `server/**` rules for package-local server
files; `LICENSE`, `NOTICE`, `CHANGELOG.md`, `README.md` allowed; SVG, links, devices and
escaping paths refused as for every content kind (marketplace design §5.4). Delivery is
the tree export, as for skills; the ledger records the tree digest (marketplace design
§5.5, §6.4). There is no artifact ladder: nothing in the package is compiled.

**Compatibility with older apps.** The Lease amendment (§6.4, decision 24, in flight)
introduces a second index surface for app 0.12.0 and later: `marketplace.2.json`
(`schemaVersion: 2`) carries every version, and `marketplace.json` (`schemaVersion: 1`)
is frozen so that an app at 0.11 or earlier keeps seeing exactly the versions it saw. The
new kind is listed **only in the format-2 index and in `schemaVersion: 2` descriptors**;
the frozen format-1 index never carries an `agent-plugin` entry, so no older app ever
sees one. Two facts make this safe even if an author hand-writes a format-1 index with
the new kind by mistake: the index validator drops an entry that fails the schema with a
diagnostic and keeps the rest of the index (`src/marketplace/catalog/validate.ts:258-272`),
and it never drops a package because of *another* package's entry (the only cross-entry
rule is a duplicate name or path, `:275-283`). An `agent-plugin` package therefore can
never make an older app lose the old versions of anything, and it sets
`minAppVersion` to the first release that ships the kind, so version choice (marketplace
design §6.1; `src/marketplace/catalog/aggregate.ts:85`, `:144`) shows it as
`upgrade_required` rather than installing it on an app that cannot read it. The trap a
review found — renaming a kind literal or adding a field to a closed object, which drops
a whole package from every older client — is avoided by never touching the `plugin`
literal (§6.2) and never adding a field to a format-1 object.

If the Lease amendment's index surface changes name or shape before it lands, this
section follows it; the rule that does not change is "the new kind is listed only where
an app that knows it will read it".

### 5.3 Install and activation

Install is the content path (marketplace design §5.5): write the files, then the ledger,
then activate; a failed activation restores the previous install. Activation registers,
in this order and each independently: skills into the skill store's package layer,
persona prompts into the persona store's package layer, template prompts into the slash
picker's data, agent profiles into the agent store's package layer, routine templates
into the Routines panel as switched-off entries, then each MCP server whose exact
fingerprint the user approved (§3.2), then hooks likewise (§3.3). A component that fails
to register is reported and the rest stay active (Agent Plugins §11.3 isolates component
failures). Disable reverses activation and keeps the files; uninstall removes the files
and, when the user chooses, `PLUGIN_DATA` for its servers.

### 5.4 Direct install

A git URL whose root (or `subdir`) holds a `plugin.json` without `entry`/`process` is a
direct `agent-plugin` install (marketplace design §8.2 gains the branch): `name`,
`version`, `description` from the manifest, `components` computed from the tree,
`minAppVersion` from the plugin branch's `requires` when present, else the first release
that ships the kind. A root that holds only `.claude-plugin/plugin.json` or
`.codex-plugin/plugin.json` is refused as a direct install with a message that points at
*Import a plugin* (§2.4), because the package must be transformed and reviewed.

### 5.5 Revocation

`policy/revocations.json` and the app-version-conditional revocations (marketplace design
§10.4; alerts design "Retirement by revocation") apply to the new kind with no new field:
`kind: "agent-plugin"`, `name`, a version range, `disable` or `uninstall`. Disable
deactivates every component (§5.3), stops the plugin's MCP servers and dismisses its
routines; the user is told why, as for every revoked package. Per-source scoping stays:
a source revokes only packages installed from it, a file-installed package has no source
and is revoked by its user.

---

## 6. Migration and vocabulary scope

### 6.1 What is renamed

Vocabulary only, in the surfaces that speak to users and readers:

- **English UI strings** whose meaning is "code package": the marketplace kind tab
  (`gitMarketplace.kind.plugin` → "Extensions", `gitMarketplace.ts:30`); the sidebar
  group (`sidebar.pluginsLabel`, `sidebar.ts:6`); the settings group and tabs
  (`settingsContent.groupPlugins`, `tabPluginConfig`, `tabPluginPerf`,
  `settingsContent.ts:16`, `:18`, `:24`); the menu (`be_main.menuPlugins`,
  `be_main.ts:4`); the general tab statistic (`generalTab.statPlugins`, `generalTab.ts:7`);
  source badges (`constants.sourceBadgePlugin`, `constants.ts:5`;
  `permissionReviewStatusCard.sourcePlugin`, `permissionReviewStatusCard.ts:13`); the
  page titles of the two extension tabs (`pluginConfigTab.pageTitle`,
  `pluginPerfTab.pageTitle`); the alert cue titles (`alerts.pluginNotificationTitle`,
  `alerts.ts:30-31`); the add-source warning (`gitMarketplace.add.codeRunning`,
  `gitMarketplace.ts:197`); and every other value among the roughly 150 English catalog
  values that contain "plugin" (counted over `src/i18n/messages/generated/*.ts`),
  reviewed one by one: a value about a code package says "extension", a value about the
  new kind says "plugin", and a value that is about both says "extensions and plugins".
  The `plugin` **keys** do not change (§6.2).
- **Korean strings** likewise; the Korean word for extension is an owner decision (§8).
- **Documentation**: `docs/architecture/architecture.md` (the "Plugin Runtime" section
  and the parity invariant describe extensions), the plugin guides under `docs/guides/`
  (`plugin-development.md`, `local-plugin-development.md`, `plugin-version-quickref.md`,
  `plugin-decoupling-migration.md`, `marketplace-publishing.md`), the web documentation
  under `web/app/docs/plugins/` and `web/app/docs/marketplace/authors/`, the packaged
  runtime guidance `resources/AGENTS.md` (its "Plugins use a manifest, runtime handler,
  and HostApi contract" sentence describes extensions), and `CHANGELOG.md` from the
  release that ships §7 slice B on. Headings and prose say "extension" for code packages;
  file names of documents are renamed only together with every inbound reference
  (AGENTS.md: grep before deleting or renaming a document), and the web pages keep their
  old paths reachable through the site's redirect rules, so a link in a published README
  keeps working.
- **Marketplace categories and copy**: the kind tab, the package sheet's section names,
  the add-source dialog, the official repository's README and the package-author page.
- **The design and blueprint pages** that describe the code-plugin machinery keep their
  file names (`plugin-hostapi-protocol.md`, `plugin-alerts.md`,
  `plugin-process-isolation.md`) and gain one sentence under their title saying the
  package they describe is called an extension from this design on; renaming a page that
  shipped code cites by section anchor would break the anchors for nothing.

### 6.2 What is not renamed, and why

| Identifier | Stays | Why |
|---|---|---|
| Plugin IDs (`^[a-z][a-z0-9-]*$`, `AGENTS.md:135`) | `meeting`, `lyra-mail`, … | They key the registry, the receipts, `~/.ave/plugins/<id>/` and its `data/`, host-secret grants (marketplace design §10.3), `pluginAccess` grants, alert kinds (`<pluginId>--<kind>`), routine scopes and audit rows. A rename is a data migration of every user's home directory for a word |
| Tool names (`^[a-zA-Z_][a-zA-Z0-9_]*$`) | unchanged | They are the model-facing surface and the permission rules' keys; the three namespaces stay distinct without runtime conversion (`AGENTS.md:189-190`) |
| IPC channels `ave:plugins:*`, `ave:marketplace:*` | unchanged | Locked by the channel inventory (`src/ipc/__tests__/channel-inventory.test.ts:1-8`) and the preload shape (`src/__tests__/preload-shape.test.ts:1-9`); a rename is a coherent handler/preload/type/caller/test change that buys nothing users see |
| `plugin.json` file name | unchanged | Agent Plugins §5.1 mandates it for both extensions and plugins; it is the specification's name, not Ave's |
| `extensions["ai.agent-connector.ave"]` key | unchanged | The client namespace the specification reserves (§8); vendored by every extension repository and hash-checked (marketplace design §5.6). The proposal's `ave-plugin.json` rename (proposal §3.2) is rejected: the collision it feared is resolved by the namespace, which the manifest already uses (`public-contract.ts:38-39`, `:47`) |
| Install receipts (`installSource`, schema v3/v4, `artifactSha256`, `manifestSha256`) | unchanged | Persisted values that the grant chain and the Doctor read (marketplace design §2.3, §10.3); AGENTS.md treats shipped audit and persisted keys as migration decisions, not renames |
| Descriptor and index kind literal `plugin` | unchanged | Every snapshot, ledger row, policy `requiredInstalls[].kind`, deep link and format-1 index carries it; renaming it is the older-app trap of §5.2 |
| i18n **keys** (`sidebar.pluginsLabel`, `gitMarketplace.kind.plugin`, …) | unchanged | Keys are identifiers the catalog gates and the used-keys checks match on; only values change |
| Code identifiers, module paths, types (`src/plugins/`, `PluginManifest`, `PluginHostApi`, `PluginContributionTrustStore`, `ave/host/*`, `hostProtocol`) | unchanged | AGENTS.md: do not rename unrelated code during another task; the protocol schema `$id`s and the vendored contract hash pin these names |
| Audit `type` keys, event namespaces (`plugin.*`, `host.*`) | unchanged | Persisted and subscribed values (`src/plugins/capabilities.ts:117-120`) |
| `OUT_OF_PROCESS_PLUGIN_IDS`, `PLUGIN_ENVELOPE_GRANTS` | unchanged | Being removed by the protocol design's own steps (protocol design §9.3); renaming a table scheduled for deletion is churn |

### 6.3 The existing eight packages become extensions with no reinstall

Classification is computed, not stored: the loader reads `entry` from the installed
manifest (§1.3) and the catalog reads `kind: "plugin"` from the snapshot (§1.4). On the
first boot of the release that ships §7 slice A, every installed code package is an
extension because its manifest has `entry`; the registry, the receipts, the data
directories, the contribution trust records, the routine scopes and the alert kinds are
untouched; the Sidebar group, the settings tabs and the kind tab show the new word. No
migration file is written, because there is no state to migrate.

`hello-world` and `templates/plugin` are extensions like the others. The official
repository's `templates/plugin` directory is renamed `templates/extension` at the
republish wave (§6.4) because it is documentation for authors and the app never reads
it (marketplace design §3.2: "the client never reads them"); the workspace entry in the
repository's `package.json` moves with it. `orion` (`orion-api`, company git) and `git` (its
own repository) change nothing but their README wording.

### 6.4 The Lease 0.12.0 cutoff: an opportunity, not a dependency

The Lease amendment fixes app 0.12.0 as the protocol-2 boundary and republishes every
extension after its v0.11.0 alerts version, with `hostProtocol: "2"` and
`minAppVersion` 0.12.0 (amendment §9.5). This design has no dependency on that wave and
the wave has none on this design: an extension is an extension whether it declares
`"1"`, `"2"` or nothing, and the refusal of an undeclared manifest on 0.12.0 is the
amendment's rule, not this page's. The wave is the opportunity to:

- update each extension's `description` and README to say "extension", since the
  package is being rebuilt and republished anyway;
- rename `templates/plugin` → `templates/extension` (§6.3) in the same monorepo change
  that re-vendors the contract;
- land the official index generator's format-2 output with the new kind's schema
  already in it (§5.2), so the first `agent-plugin` package can be listed the day
  slice C ships.

If the wave slips, §7 slices A and B ship unchanged and slice C waits for a format-2
index reader, which is the amendment's slice C (amendment §9.6), not a second one.

---

## 7. Release and slicing

Constraints: nothing lands in v0.11.0 (the alerts release, owner direction); the Lease
amendment owns 0.12.0's protocol boundary and its own slices A–E2 (amendment §9.6);
each slice below is based on `main` after the previous merges and carries the
documentation for what it changes. Lock suites are named where a slice touches them.

| Slice | Scope | Focused gates | Lock suites |
|---|---|---|---|
| **A. Design** | this page; the superseded pointer on the 2026-08-16 proposal; the design README entry | markdown policy, naming gate against `origin/main`, link check of the citations | none |
| **B. Vocabulary and classification** | i18n values in `en` and `ko` for every "plugin" value that means a code package (§6.1), with keys unchanged; docs, web pages (with redirects), `resources/AGENTS.md`, `CHANGELOG.md` `## Unreleased`; a pure `isExtensionManifest(manifest)` in `src/plugins/` (true iff `entry` or `process` is present) used by the Sidebar group, the settings tabs, the Doctor labels and the package sheet section names; kind tab order. No schema, IPC, settings or `package.json` change | `check:i18n-catalog`, `check:i18n-barrels`, the used-keys gate the marketplace labels rely on (`labels.ts:1-4`), and a CDP run of the app from the worktree reading the sidebar, settings and marketplace tab text (an i18n parity check cannot see a missing key; only a running app can); Playwright specs that assert labels; `bun run typecheck`; `bun run build` (carries the i18n checks) | `channel-inventory`, `host-renderer-only-channels`, `domain-exports`, `preload-shape`, `settings-store` and `packaging-discipline-source` unchanged; naming gate |
| **C. The `agent-plugin` kind** | `PACKAGE_KINDS`, `schemas/marketplace/package.schema.json` and `index.schema.json` (format 2 only), descriptor `components`, content rules, tree install and ledger, activation of skills, prompts (both kinds, including the `plugin-prompt-emitted` origin sweep), agent profiles, routine templates (installed off) and MCP servers with fingerprint approval (§3.2) plus the `allowUserApprovedServers` policy rule; the manifest schema's discriminated namespace block (§2.1) and its public type; direct-install detection; deep-link and policy kind acceptance; `repository-check.ts`; package sheet Components section and update-review delta; the extension contribution set gains routine templates and prompts (§1.3, reason 2). **Lands after the Lease amendment's slice C** (format-2 reader). Uses the existing `ave:marketplace:*` channels; DTOs in `src/shared/git-marketplace.ts` grow | catalog validate fixtures for the kind (valid, each invalid rule, unknown keys, format-1 index with the kind → dropped per entry, older-app snapshot unchanged); content rules; content service activation and rollback; skill/persona/agent store package layers; routine template switch-on with caps and scope; MCP projection fingerprint, approval-not-transferring-across-versions, policy collision, `allowUserApprovedServers: false`; `mcpAuth` schema; manifest schema `oneOf` fixtures (extension, plugin, neither); direct-install branches; repository-check bundle rebuilt for the official repository; the git-marketplace lifecycle E2E adds one `agent-plugin` package with a skill, a prompt, a routine template and a stdio server | `src/shared/git-marketplace.ts` DTO tests; `preload-shape` only if the bridge grows a method (it does not: existing channels carry the kind); settings suites unchanged (routine templates are routines, not settings; the policy rule is in the governance file); `domain-exports` unchanged; `packaging-discipline-source` unchanged; manifest schema and hardening tests; naming gate |
| **D. Studio: create, import, export, install from file** | `~/.ave/studio/` namespace and `draft.json`; the three `plugin_studio_*` tools; the form flow; the review page; import (§2.4) and export projections; *Install from file*; *Share* with `reviewedAt`; the advisory lint. One new IPC domain `ave:plugin-studio:*` (list/read/write drafts, validate, import, export, install-from-file) registered with its handlers, preload bridge, shared types, callers, sender guard and tests in one change (AGENTS.md, "A new IPC channel is one coherent change") | tool registry and executor parity tests for the three tools (approval-gated, `builtin`, `meta`); draft namespace permissions (`0o700`/`0o600`); import fixtures for each detection branch and each mapping row of §2.3, including every rejection; export round-trip (export → import equals the source package); lint fixtures; install-from-file goes through the package sheet and records `sourceId: null`; a Playwright spec for form → review → install | **`channel-inventory`, `host-renderer-only-channels`, `domain-exports`, `preload-shape`, `preload` updated in the same change**; `settings-store` unchanged (no setting); `packaging-discipline-source` unchanged unless a script is added (none planned); naming gate |
| **E. Hooks in plugins** | `ai.agent-connector.ave/hooks.json` loading through the plugin hook projection and trust store; the `${PLUGIN_ROOT}` anchoring rule of §3.3; the package sheet's hook consent; export/import of hooks (§2.3) | hook parse and rejection fixtures per §2.3 row; anchoring refusals; exact-generation approval and re-ask on update; runner timeout and output caps; a real spawned hook in the macOS and Linux CI jobs | hook registry and trust tests; no channel, preload, settings or script change; naming gate |

Validation discipline follows the repository contract (`AGENTS.md`, "Validation:
proportional during work, complete once at publish"): narrow vitest runs while iterating,
`bun run typecheck`, then one full `bun run test` and `bun run build` before each slice is
published, the pre-push hook, CI `build-and-test` and `naming-gate` green on the check
rollup before merge, and `.github/scripts/naming-gate.sh origin/main HEAD` locally with
GNU grep (`naming-gate.sh:25` fails closed without PCRE).

**Plugin and monorepo changes** (official repository `ken-jo/agent-marketplace`,
`6a4d3b3df`; five `plugin` packages and `templates/plugin` at that commit):

1. With the Lease republish wave (amendment §9.5 step 4): README and `description`
   wording, `templates/plugin` → `templates/extension`, the index generator writes the
   format-2 file with the `agent-plugin` schema present, `tools/repo.mjs` learns
   `components` extraction, the vendored checker is rebuilt from the app tag that ships
   slice C.
2. After slice C: one official `agent-plugin` package as the launch example — a
   meeting-notes kit made of one skill, one template prompt and one routine template,
   with no MCP server, so the first thing a user installs from the new tab executes no
   code. Its `minAppVersion` is the release that ships slice C.
3. `orion` and `git`: README wording only, at their next ordinary release.

**Order relative to releases.** Slice A now. Slice B merges to `main` after the v0.11.0
tag and ships in 0.12.0 with the Lease (recommended, §8 decision 1) so the republish
wave and the new word arrive together. Slice C merges after the amendment's slice C and
ships in 0.12.0 if it merges before the amendment's E1 release PR is cut, otherwise in
0.13.0; the catalog kind's `minAppVersion` floor is whichever release it ships in. Slices
D and E ship in 0.13.0. None of this moves v0.11.0 or the Lease boundary.

---

## 8. Open owner decisions

Only product choices remain; every technical question is decided above.

| # | Decision | Recommendation |
|---|---|---|
| 1 | **Which release carries the vocabulary change (slice B):** 0.12.0 together with the Lease republish wave, or 0.13.0 on its own | **0.12.0.** The wave rebuilds and republishes every extension anyway; users read one release note that says "your plugins are now extensions; plugins are the new thing", and the official README, template and descriptions change once. Shipping the word a release later means the marketplace shows "Plugins" for code packages while the official repository already calls them extensions |
| 2 | **The Korean word for "extension"** in the UI: 확장 (the established software term) or 익스텐션 (transliteration) | **확장**, with "확장 기능" where a bare noun reads oddly in a label; keep 플러그인 for plugins. The two words must never appear as translations of each other |
| 3 | **Whether the app should ever commit and push to a git marketplace** (a later slice) instead of writing the package into a checkout for the user to push | **No.** The marketplace's git contract is read-only by design and holds no write credential; publishing is a pull request reviewed by the marketplace owner, and a wrong push from an app is not recoverable by the app. Export plus a team marketplace covers sharing |
| 4 | **Whether plugin routine templates may be `llm-session`** at launch, or `notification-only` only | **Both**, installed off, each switched on individually with its full prompt shown and its scope confirmed (§3.4). Restricting to notifications would make the most useful no-code plugin, a scheduled task, impossible to share |
| 5 | **Whether an official example plugin ships with slice C** | **Yes, one** (§7, monorepo item 2), executing no code, so the new tab is not empty on day one and the review sheet has a benign reference |

---

## 9. Decisions

| # | Decision | Reason |
|---|---|---|
| 1 | Extension ⇔ `extensions["ai.agent-connector.ave"]` has `entry` or `process`; a plugin has neither; the schema makes the block a discriminated shape so a package is never both (§1.3, §2.1) | The marker already exists and is required (`schema:122-125`); two lifecycles cannot share a package; an extension already carries every component a plugin can |
| 2 | Trust attaches to components and capabilities, never to the label (§1.5) | An MCP server is a process wherever it is declared; the controls it needs already exist and are reused unchanged |
| 3 | Plugins conform to Agent Plugins 1.0.0 with Ave components under the `ai.agent-connector.ave` manifest key and directory, discovered at fixed locations without declarations (§2.1) | The manifest already is such a document; fixed locations are the specification's own design and remove a second source of truth |
| 4 | Launch components: skills, MCP servers, prompts (template and persona), agent profiles, routine templates; hooks one slice later; everything else ignored with a diagnostic, and the listed ones rejected by name (§2.2) | Each supported component maps onto a store or path the host already has; hooks need command execution and their own slice; the rejected ones would each add a surface |
| 5 | Commands become template prompts through the MCP-prompt surface; hooks map onto the closed Ave event set in argv form only; unmappable events and handler types are rejected by name (§2.3) | The slash picker already carries author-written prompts with non-keyboard provenance; the hook runner spawns argv and nothing else |
| 6 | Import and export are studio operations that produce a reviewed draft, never part of install (§2.4) | The transformation drops and rewrites fields; the user must see the result before it runs |
| 7 | A plugin's MCP servers go through the extension-bundled projection: fingerprint approval that never transfers, runtime approval while enabled, governance at connect, ASRT wrap when the sandbox is on, `low` tier (§3.2) | The path exists, is tested, and is the same one hand-added and extension-bundled servers use; no new path means no new back door |
| 8 | A governance global rule `allowUserApprovedServers` (default `true`) lets an organization switch off user-approved MCP servers for plugins and extensions alike (§3.2) | Today the runtime-approval path has no administrator switch; adding one for plugins only would leave the extension path as the exception |
| 9 | `mcp.json` carries no secret; a plugin declares `mcpAuth` in its manifest and the host's MCP secret handling injects the value (§3.2) | The specification forbids secrets in `env`; the host already has one secret path per server |
| 10 | Routine templates install disabled and are switched on one at a time with their prompt and scope shown (§3.4) | Installation is not consent to an unattended turn; the routines store's caps and deny-all default do the rest |
| 11 | Template prompts get their own `ChatInputOrigin` value beside the MCP-prompt one (§3.5) | Attribution must say who wrote the text; reusing the MCP value would misattribute it |
| 12 | The studio composes from installed skills, routines, connectors, prompts and profiles plus model-authored text; it never composes code, hooks or scripts (§4.1) | No-code means no code; the studio says so instead of degrading |
| 13 | Conversation-driven creation uses three approval-gated builtin tools that write only under `~/.ave/studio/` and cannot install, share or read secrets (§4.2) | The assistant may draft; only the user installs |
| 14 | A draft installs as a source-less package through the content path, with provenance recorded in the files (§4.3) | The `origin: null` shape exists for pasted servers; provenance must travel with the package, not with the studio |
| 15 | Sharing is export-a-file or write-into-a-marketplace-checkout; the app never pushes (§4.5) | The git contract is read-only; a merge is the publish |
| 16 | Author review with `reviewedAt` before sharing, installer review of full texts before installing, and an advisory injection lint that is explicitly not a security control (§4.6) | The permission system is the control; the reviews make the text visible; a heuristic must not be sold as a gate |
| 17 | New kind literal `agent-plugin`; the `plugin` literal keeps its value; kind tab order puts Plugins first (§5.1) | The literal names the specification; the old literal is persisted everywhere; ordinary users come first |
| 18 | The descriptor's `components` summary is the plugin analogue of `PluginAuthority`: copied into the index, shown before download, diffed on update, compared at install (§5.2) | The catalog must show what executes before any byte is fetched, as it does for extensions |
| 19 | The new kind is listed only in the format-2 index and `schemaVersion: 2` descriptors; the format-1 index never carries it; an older app that meets one drops that entry alone (§5.2) | The older-app trap is a renamed literal or a widened closed object; neither happens |
| 20 | Delivery is the tree export with a tree digest; no artifact ladder (§5.2) | Nothing is compiled; skills already ship this way |
| 21 | Identifiers are not renamed: IDs, tool names, channels, `plugin.json`, the namespace key, receipts, the `plugin` kind literal, i18n keys, code names (§6.2); the proposal's `ave-plugin.json` rename is rejected | Each is persisted, vendored, hash-pinned or locked; the collision the proposal feared is solved by the namespace the manifest already uses |
| 22 | Existing packages become extensions by classification at load and in the catalog; no migration file, no reinstall (§6.3) | Classification is derived from `entry`; nothing on disk changes meaning |
| 23 | No dependency on the Lease wave; the wave carries the README, template and index-generator changes (§6.4) | Extensions are extensions under any protocol version; the wave is the cheapest moment to change wording |
| 24 | Five slices with the gates and lock suites of §7; B ships in 0.12.0 (subject to §8 decision 1), C after the amendment's format-2 reader, D and E in 0.13.0; nothing in v0.11.0 | Owner constraint; each slice is coherent at its own boundary; the format-2 reader is written once |

---

## 10. Rejected alternatives

1. **Keep one concept and call the standard bundle a "content pack".** Ordinary users
   would meet three words (plugin, pack, extension) for two things, and the standard's
   own word for the bundle is plugin. Rejected by the owner's direction.
2. **Rename the descriptor kind `plugin` → `extension` and use `plugin` for bundles.**
   The older-app trap of §5.2: every existing package's old versions vanish from every
   older client, and every policy file and deep link that names the kind breaks.
3. **Let a package be both (an extension with a plugin's fixed directories).** Two
   lifecycles in one receipt; and an extension already declares the same components.
4. **Read other hosts' component directories (`commands/`, `hooks/hooks.json`,
   `.mcp.json`) natively at load.** It assigns semantics to locations the specification
   does not fix, makes the loader's behaviour depend on another product's layout, and
   skips the review the transformation needs. The importer does it once, visibly.
5. **Support hook handler types beyond `command`.** Each is a new surface (a network
   call, a model evaluation, an agent run) with its own trust question; none maps onto
   the host's runner.
6. **Run plugin MCP servers through `hostFetch` or give them a lease.** They are not
   HostApi peers; a lease for a process the host does not speak to would be a credential
   with no chokepoint. The MCP path is the correct path.
7. **Skip per-component consent because the plugin "runs no code".** An MCP server and
   a hook run code; a routine starts a turn. The label cannot stand in for the review.
8. **Push to a git marketplace from the app.** Write credentials, branch protection and
   an unrecoverable wrong push, for a step a pull request does better.
9. **Make the injection lint a gate.** A phrase-matching gate is bypassed by rephrasing
   and would be presented as protection it does not give.
10. **A separate `ave-plugin.json` manifest for extensions** (the 2026-08-16 proposal).
    The namespace the manifest already uses is the specification's answer to that
    collision.

---

## 11. Sources

External documentation consulted for this page, all accessed 2026-09-27 (KST):

1. Agent Plugins Specification v1.0.0 (Status: Published) —
   https://agent-plugins.org/specification. Used: §4.2 standard layout; §5.1–5.2 manifest
   location and the closed ten-key object with required `$schema`, report-and-ignore for
   unknown top-level fields; §6 fixed component locations; §7.1 skills (`skills/`,
   Agent Skills as the format authority); §7.2 MCP servers (`mcp.json`); §8 client
   extensions (reverse-domain manifest key and top-level directory); §9 `PLUGIN_ROOT`,
   `PLUGIN_DATA`, placeholder expansion, no secrets in `env`; §11.3 unsupported
   components; Design decisions "Why only Agent Skills and MCP in v1" (commands, hooks,
   agents, rules and LSP servers are outside v1).
2. Agent Skills specification — https://agentskills.io/specification. Used: directory
   structure (`SKILL.md`, `scripts/`, `references/`, `assets/`); frontmatter `name`,
   `description`, `license`, `compatibility`, `metadata` (string map), `allowed-tools`.
3. Claude Code plugin manifest reference —
   https://code.claude.com/docs/en/plugins-reference. Used for the importer and exporter
   (§2.4): `.claude-plugin/plugin.json` with `name` the only required field; default
   component locations (`skills/`, `commands/`, `agents/`, `hooks/hooks.json`,
   `.mcp.json`, `.lsp.json`, `output-styles/`, `workflows/`, `themes/`, `monitors/`,
   `bin/`, `settings.json`); the `commands` map fields (`description`, `argumentHint`,
   `model`, `allowedTools`); `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
   `${CLAUDE_PROJECT_DIR}`; `${user_config.*}`.
4. Claude Code marketplaces and hooks — https://code.claude.com/docs/en/plugin-marketplaces
   (`.claude-plugin/marketplace.json`, entry `source` forms, reserved names) and
   https://code.claude.com/docs/en/hooks (hook events and the handler types `command`,
   `http`, `mcp_tool`, `prompt`, `agent`; exec and shell forms). Used for §2.3.
5. Codex plugins — https://developers.openai.com/codex/plugins and
   https://developers.openai.com/codex/plugins/build. Used for §2.4: root `plugin.json`
   with the Agent Plugins schema, `skills/`, `mcp.json`, `extensions.com.openai`,
   `.codex-plugin/plugin.json` as a compatibility fallback, a `hooks/` directory,
   marketplace files at `.agents/plugins/marketplace.json` and
   `~/.agents/plugins/marketplace.json`, the legacy-compatible
   `.claude-plugin/marketplace.json`.
6. Codex skills — https://developers.openai.com/codex/skills. Used: `agents/openai.yaml`
   optional metadata (interface, `policy.allow_implicit_invocation`, tool
   dependencies), which the importer ignores with a diagnostic; skill locations.
7. MCP Registry `server.json` format —
   https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md.
   Used: schema `2025-12-11`; `packages[]` with `registryType` (`npm`, `pypi`, `oci`),
   `identifier`, `version`, `runtimeHint`, `transport`, `environmentVariables`
   (`isSecret`, `isRequired`), `packageArguments`; `remotes[]` with `streamable-http`
   and URL variables. The `mcp` kind's `server.json` mapping (marketplace design §5.2)
   is unchanged by this page; a plugin's `mcp.json` is the Agent Plugins shape, not
   `server.json`.

---

## UNVERIFIED in this document

- The Codex `hooks/` directory format (source 5 names the directory; its file format was
  not read). The importer therefore does not read it; if it is the `hooks.json` shape of
  §2.3, a later change can map it with the same table.
- Whether the "used-keys gate" the marketplace labels module names
  (`src/ui/renderer/tabs/git-marketplace/labels.ts:1-4`) is a separate script or part of
  `check:i18n-catalog`; slice B runs both catalog scripts and a CDP read regardless.
- The Lease amendment's final file name for the format-2 index (`marketplace.2.json` on
  the in-flight branch) and its slice letters; §5.2 and §7 follow the amendment as
  merged.
- The exact count of English catalog values that contain "plugin" (about 150 at
  `f1a8d191e` by a case-insensitive grep over the generated catalogs); slice B reviews the
  list it computes at the time.
