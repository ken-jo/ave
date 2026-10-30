# Extensions and plugins

Plugin names such as `mail`, `portal` and `assistant` in this
record are generic stand-ins for plugins that are no longer part of this project.

**Current contract.** The app is Ave and serves host protocol `"3"` only, the `ave/*`
wire (`HOST_PROTOCOL_VERSIONS_SERVED`, `src/plugins/isolation/host-api-wire.ts:56`).
An extension for app 0.14.0 or later declares
`extensions["ai.agent-connector.ave"].requires.hostProtocol: "3"` and
`requires.minAppVersion: "0.14.0"`, vendors
`schemas/plugin-host-protocol/3/protocol.schema.json`, and a package is published
with an `ave-package.json` descriptor; the user data folder is `~/.ave`. A protocol `2`
package (the protocol-2 wire of apps 0.12–0.13) is refused before activation. The
`ai.agent-connector.ave` manifest key and package directory (Ave's domain reversed) are the
only ones Ave reads; any other extension namespace is another vendor's data. Where §6.3-6.4 below say
`hostProtocol: "2"`, they record the 0.12.0 Lease wave, not the current rule.

Status: design, decided by owner direction of 2026-09-27 and the owner decisions
recorded in §8; implementation follows the slices of §7. This page supersedes
the 2026-08-16 plugin-concept comparison proposal, which was removed from the
docs; git history keeps it.

Anchors: `docs/architecture/architecture.md` (Plugin Runtime, MCP↔plugin execution
parity, OS Execution Sandbox And Plugin Workers),
`docs/design/multi-source-git-marketplace.md` (the catalog, descriptors, content kinds,
revocation; cited below as "marketplace design"),
`docs/design/plugin-hostapi-protocol.md` (the HostApi protocol, Lease and Admission;
cited as "protocol design"; its Lease amendment is final at commit `e0f687db8` of
`docs/hostapi-lease-amendment`, PR #2576, cited as "amendment"),
`docs/design/plugin-alerts.md` (the v0.11.0 release).

Every claim about current code names a `file:line` in the ave `f1a8d191e`
checkout (main after the alerts follow-up merged). Claims about the official marketplace
repository name its commit `6a4d3b3df`. Where this page depends on the amendment it
names the amendment's section and does not restate it. Claims about other hosts cite
their official documentation (§11) with the access date. The one claim this page could
not verify is listed at the end.

---

## 0. The split in one table

The owner's direction splits today's single "plugin" concept in two:

| | **Extension** | **Plugin** |
|---|---|---|
| What it is | Today's code plugin: `meeting`, `mail`, `local-indexer`, `assistant`, `hello-world`, the `templates/plugin` scaffold, `portal`, `git` | A standard Agent Plugins 1.0.0 bundle: skills, MCP servers, prompts, agent profiles, routine templates and (one slice later) hooks, with no Ave runtime code |
| Structural marker | `extensions["ai.agent-connector.ave"].entry` (required today, `schemas/plugin-manifest.schema.json:122-125`, `:135-138`), or the `process` entry the amendment adds (amendment §2.1) | no `entry` and no `process` under `extensions["ai.agent-connector.ave"]` |
| Runs | its own confined process speaking `ave/host/*` and MCP (protocol design §2, §3) | nothing of its own. Its MCP servers run as MCP servers do today; its hooks run as bundled hooks do; its other components are content the host reads |
| Lifecycle gates | Lease and Admission (amendment §9.1) | the content install path and the per-component consent of §3 |
| Who writes it | a developer against the vendored contract (marketplace design §5.6) | a developer against the public Agent Plugins format, **or** an ordinary user inside the app with no code (§4) |
| Marketplace kind literal | `plugin` (unchanged identifier, §6.2) | `agent-plugin` (new, §5.1) |
| User-facing word | Extension / 익스텐션 | Plugin / 플러그인 |

Existing packages are *offered as extensions*: nothing about them is reinstalled,
re-signed or re-identified (§6.3). The word changes; the identifiers do not.

---

## 1. Definitions and the boundary

### 1.1 Extension

An **extension** is a package whose `plugin.json` carries a runtime entry under the Ave
namespace. Today the namespace block requires `entry` and `tools`
(`schemas/plugin-manifest.schema.json:122-125`), the loader refuses a manifest whose
`entry` is not a non-empty relative path
(`src/plugins/runtime/manifest-validation.ts:919-923`), and the amendment adds
`process` as the second form of the same thing (amendment §2.1: exactly one of the two;
a bare executable or `./`-relative path, placeholders expanded in `args` and `env` only,
spawned through `spawnConfinedChild`). The host projects the namespace block onto its
internal manifest with `flattenAgentPluginsManifest`
(`src/plugins/public-contract.ts:105-129`), whose `name` lands on `id`.

An extension is what the protocol design, the amendment and the alerts design govern:
one process per package, `ave/host/*` as its only reach into the host, `hostFetch` as
its only network egress (`src/main/host-fetch-guard.ts:1-24`,
`src/boot/steps/plugin-runtime/host-api-factory.ts:990`, `:1083`), manifest
`capabilities`, `networkAccess`, `hostSecrets`, `pluginAccess`, `alerts`, `sandbox`
authority (amendment §2.2), install receipts and host-secret grants (marketplace design
§10.3).

An extension may still bundle skills, hooks and MCP server configurations through the
contribution declarations that already exist (`schemas/plugin-manifest.schema.json:232-255`;
`src/plugins/public-contract.ts:466-470`; `src/plugins/plugin-contributions.ts:105-110`).
That surface is unchanged by this page: an extension author who wants those components
ships them in the extension.

### 1.2 Plugin

A **plugin** is an Agent Plugins 1.0.0 package (§11, source 1) whose manifest has no
runtime entry. It is a directory the host reads, not a program the host runs:

- `skills/<name>/SKILL.md` — Agent Skills (Agent Plugins §7.1; Agent Skills
  specification, source 2), loaded through the skill store's plugin-skill map with a
  package-qualified selector (§3.5);
- `mcp.json` — MCP servers in the Agent Plugins `mcp.schema.json` shape (Agent Plugins
  §7.2), parsed by a portable parser and projected onto the host's MCP runtime spec
  (§2.1 item 5, §3.2);
- `ai.agent-connector.ave/prompts/<name>.md` — prompts (§2.2);
- `ai.agent-connector.ave/agents/<name>/AGENTS.md` — sub-agent profiles, the content the `agent`
  kind delivers today (`src/main/agent-profile-store.ts:1-11`);
- `ai.agent-connector.ave/routines.json` — routine **templates** the user may create a routine from
  (§2.2, §3.4); a plugin never ships a routine that runs;
- `ai.agent-connector.ave/hooks.json` — declarative hooks in the host's own `hooks.json` format,
  gated as extension-bundled hooks are (`src/hooks/plugin-hook-projection.ts:14-31`) and
  confined as §3.3 states; a later slice (§7).

The `ai.agent-connector.ave/` directory is the file-based client extension the specification
reserves for a client's own components (Agent Plugins §8.2); the manifest's
`extensions["ai.agent-connector.ave"]` block is its manifest-data half (§8.1). Both are what the
manifest schema already declares as the Ave namespace (`src/plugins/public-contract.ts:47`).

### 1.3 The boundary rule and why one package is never both

**Rule.** A package is an extension if and only if `extensions["ai.agent-connector.ave"]` carries
`entry` or `process`. Everything else that parses as an Agent Plugins manifest is a
plugin. The rule is evaluated from the manifest bytes after schema validation, never
from the marketplace kind, the source badge, the package name or a user setting; the
marketplace kind (§5.1) must agree with it, and a disagreement is `MANIFEST_MISMATCH`
at install (marketplace design §6.2), the same refusal as a descriptor that disagrees
with its `plugin.json`.

**A malformed marker refuses the package; it never downgrades it.** A block whose
`entry` or `process` is present but of the wrong type, empty, or present together with
the other marker matches no branch of the schema (§2.1) and the manifest is refused with
the branch mismatch named. The schema checks the marker's shape only (`entry` is a
non-empty string, `schemas/plugin-manifest.schema.json:135-138`; the runtime check at
`src/plugins/runtime/manifest-validation.ts:919-923` is the same); an absolute or
escaping `entry` passes the schema, still matches the entry branch — so the package is
still an extension — and is refused later by the containment gate that resolves the
entry inside the plugin directory (`resolvePluginEntryPath`,
`src/plugins/runtime/sandbox.ts:37-54`), before anything is spawned. A package is
classified only after it validated, and both refusals are refusals of an extension:
there is no path on which a broken extension is loaded as content.

**One package is never both.** The manifest schema makes the namespace block a
three-branch `oneOf` (§2.1): two extension branches (`entry` xor `process`) and one
closed plugin branch that admits neither. Reasons:

1. Two lifecycles. An extension is admitted, leased, spawned, budgeted and retired by
   the protocol machinery; a plugin is installed, activated and revoked by the content
   machinery. A package that is both would need two receipts, two provenance rules and
   two revocation behaviours, and the host would have to decide which one wins when
   they disagree. The protocol design's "data, not code" admission test (protocol design
   §4, "the plugin contributes data and the host contributes code") is exactly the line
   this rule draws at the package level.
2. Nothing is lost. An extension already carries skills, hooks and MCP servers as
   contributions (§1.1). The only things a plugin has that an extension cannot declare
   are routine templates and prompts, and both are added to the extension contribution
   set in the same slice that adds them to plugins (§7, slice C), so an author never has
   to choose a plugin to get a component.
3. Trust attaches to components (§1.5). Two natures in one package would give the label
   a meaning the consent sheet must then explain away.

The file tree is not part of the discriminator: a JSON schema cannot see sibling
directories, and an extension legitimately carries skill and hook files. The tree is
checked separately, by kind, after classification (§2.1 item 6).

### 1.4 How the marketplace and the UI classify

| Surface | Extension | Plugin |
|---|---|---|
| Descriptor / index `kind` | `plugin` (§6.2 keeps the literal) | `agent-plugin` (§5.1) |
| Conventional layout directory (marketplace design §3.3) | `plugins/` | `agent-plugins/` |
| Direct install detection (marketplace design §8.1; `src/marketplace/sources/direct-package.ts:108-115`) | `plugin.json` with `entry` or `process` → `kind: "plugin"` as today | `plugin.json` without either → `kind: "agent-plugin"`; today's refusal of a manifest without the namespace block (`direct-package.ts:112`) becomes "no namespace block, or a block with neither marker → plugin" |
| Kind tab label (`src/ui/renderer/tabs/git-marketplace/labels.ts:17-31`; `src/i18n/messages/generated/gitMarketplace.ts:30-38`) | "Extensions" / "익스텐션" | "Plugins" / "플러그인" |
| Sidebar group (`src/ui/renderer/components/Sidebar.tsx:406-407`, `:2420-2421`; `src/i18n/messages/generated/sidebar.ts:6`) | "Extensions" (installed extension rows and their UI slots) | none: a plugin has no UI slot |
| Settings groups and tabs (`src/i18n/messages/generated/settingsContent.ts:16`, `:18`, `:24`) | "Extensions", "Extension settings", "Extension performance" | plugins appear in the Marketplace tab's Installed view and in the surfaces their components already have (skills in the slash picker, MCP servers in MCP settings, routine templates in the Routines panel) |
| Package sheet (marketplace design §15.2) | Permissions from `PluginAuthority`, Delivery rungs | **Components** from the descriptor's component summary (§5.2): each component with its trust class (§1.5) and its content digest |
| Doctor, plugin-status, alerts source labels | say "extension" | not applicable |

### 1.5 Trust is decided per component and capability, never by the label

The label "plugin" grants nothing and the label "extension" costs nothing. What decides
trust is what a component *is*:

| Component | Class | What decides, and where it already exists |
|---|---|---|
| Skill (`SKILL.md`, `references/`, `assets/`) | instructions the model may load | the `skill_load` tool's approval gate (`src/tools/skill-load.ts:118-121`, `:208-222`) and the skill content limits (`src/marketplace/content/rules.ts:48-52`). A skill's `scripts/` are never executed by the loader; the model may run them only through the shell tool under the normal permission path, and the review sheet flags a skill that ships `scripts/` |
| MCP server (`mcp.json`) | **code that spawns a process** (stdio) or a network peer (streamable HTTP) | governance Layer 1, deny by default (`src/mcp/mcp-governance.ts:77`, `:168-178`); an exact-fingerprint approval that never transfers to another version (`src/plugins/plugin-contribution-trust.ts:5`, `:21-28`; `src/mcp/plugin-mcp-projection.ts:23-30`); the ASRT wrap when the sandbox is on, fail-closed (`src/mcp/mcp-client.ts:2156-2172`); tool trust tier `low` like every MCP server (`src/tools/types.ts:83-90`; `src/mcp/mcp-tool-adapter.ts:24-27`). §3.2 |
| Hook (`ai.agent-connector.ave/hooks.json`) | **code the host runs on its own events** | the `hooks.json` trust unit and lockfile (`src/hooks/hook-config-trust.ts:1-22`), the exact-generation approval for bundled hooks (`src/hooks/plugin-hook-projection.ts:14-31`), the closed event set (`src/hooks/script-hook-types.ts:56`, `:74-86`), the per-entry timeout and output caps (`:261`, `:264`), and the confinement §3.3 adds for bundled hooks. §3.3 |
| Routine template (`ai.agent-connector.ave/routines.json`) | a suggestion for an unattended turn; **not a routine** | nothing runs from it. A routine exists only after the user creates one through the ordinary routine-creation flow with its approvals, and the user owns it (§3.4, owner decision 4) |
| Prompt (`ai.agent-connector.ave/prompts/*.md`) | text the user chooses to send, written by someone else | a user click in the slash picker, a non-keyboard provenance origin (the shape MCP prompts use, `src/shared/chat-origin.ts:17-24`; `src/ui/renderer/components/slash-picker-data.ts:18-30`), and the leading-slash strip (`src/shared/slash-sanitizer.ts:7-15`). §3.5 |
| Agent profile (`ai.agent-connector.ave/agents/`) | a sub-agent prompt | the same store and `agent_spawn` path as the `agent` kind (`src/main/agent-profile-store.ts:1-11`) |
| Extension code (`entry` / `process`) | a process with a HostApi connection | Lease, Admission, receipts, manifest authority (amendment §7; marketplace design §10) |

An MCP server inside a plugin is therefore exactly as trusted as the same server added
by hand or bundled by an extension: it is a process, it gets the process controls, and
the word on the tab does not move it. The same holds for a hook.

---

## 2. The plugin format

### 2.1 Alignment with Agent Plugins 1.0.0

The manifest schema already is an Agent Plugins document: the top level is the
specification's closed ten-key object with `$schema` fixed to
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`
(`src/plugins/public-contract.ts:38-39`; `schemas/plugin-manifest.schema.json:7-14`
with `additionalProperties: false`), and everything Ave-specific sits under
`extensions["ai.agent-connector.ave"]` (`:47`). Plugins use the same file, the same top level and
the same namespace. The complete root contract after this design:

1. **Root `required` becomes `["$schema", "name"]`**, which is what the official
   schema requires (source 1, `plugin.schema.json`). `version` and `description` stay
   in the schema as optional, closed-shape fields. They are **marketplace-required**,
   not schema-required: every descriptor, index entry and direct install needs both
   (marketplace design §5.2; `src/marketplace/sources/direct-package.ts:108-110`), and
   an extension's loader keeps requiring them through the extension branches below. A
   portable package with only `$schema` and `name` therefore parses, and is refused
   only at the marketplace or studio boundary that needs a version, with the missing
   field named. `extensions` becomes optional at the root: a plugin with no Ave data
   has no block at all, which is what a package written for another host looks like.
   **The host's `name` is a stated subset of the standard's**: the retained pattern
   (`schemas/plugin-manifest.schema.json:20-28`) admits kebab-case only, three to
   sixty-four characters, no leading digit, no dot and no double hyphen, while the
   official schema admits shorter names, leading digits and dots. A portable package
   whose name is outside the subset is refused at parse with the pattern named; the
   "loads unchanged" promise below holds for names inside it. The subset is kept
   because the name is also the package identity in every persisted place (§6.2) and,
   for a plugin, the package segment of the secret key and the selectors of §3.2 and
   §3.5. Should dots ever be admitted, those keys already use a segment encoding that
   cannot collide (§3.2, Storage).
2. **The namespace block is a three-branch `oneOf`**:
   - **entry extension**: today's block with `entry` required and `process` forbidden
     (`schemas/plugin-manifest.schema.json:122-125` plus `"not": { "required": ["process"] }`);
   - **process extension**: the amendment's block (amendment §2.1) with `process`
     required and `entry` forbidden; `tools` required in both extension branches, all
     other extension fields as today;
   - **plugin**: `additionalProperties: false` over `displayName`, `icon`, `iconText`,
     `requires: { minAppVersion }` and `mcpAuth` (§3.2). No `entry`, no `process`, no
     `tools`, no capability, network, secret, access, alert, UI or sandbox field: a
     plugin has nothing those fields would govern.
   The branches are mutually exclusive by construction (each forbids the other two's
   markers), so `oneOf` never matches twice, and a block with a malformed marker
   matches none and is refused (§1.3). Today's closed block has no `process` property
   (`schemas/plugin-manifest.schema.json:119-145`), so the process branch is new schema
   text written with the amendment's slice C, which owns the public type
   (amendment §9.6).
3. **Installed-manifest normalization is preserved.** An installed extension manifest
   that still carries the retired `installPolicy` / `publisher` fields loads after the
   loader strips them with one warning (`src/plugins/runtime/manifest-validation.ts:98-119`);
   a git install refuses them. Nothing in this design touches that path, and a plugin
   has no retired field to strip.
4. **Fixed component locations, no declarations.** Skills are discovered at `skills/`
   and MCP servers at `mcp.json` as the specification fixes them (Agent Plugins §6, §7);
   Ave components are discovered at fixed paths under `ai.agent-connector.ave/` (§1.2). The
   extension branch's `skills`/`hooks`/`mcpServers` declaration arrays
   (`src/plugins/public-contract.ts:466-470`) are not used by plugins: the specification
   already fixes the portable locations, and a declaration that could disagree with a
   fixed location is a second source of truth.
5. **`mcp.json` is parsed as the portable format, then projected.** The file's shape is
   the official `mcp.schema.json` (source 1): its own `$schema`
   (`https://agent-plugins.org/schemas/1.0.0/mcp.schema.json`, required), a
   `mcpServers` map, and per server `type: "stdio"` (`command`, `args`, `env`, `cwd`)
   or `type: "streamable-http"` (`url`, `headers`). The host's runtime spec is a
   different shape — `transport: "stdio" | "http"` (`src/mcp/types.ts:141-147`,
   `:173-175`), which the bundled projection parses and which refuses unknown fields
   (`src/mcp/plugin-mcp-projection.ts:70-80`). Three functions, one module, with the
   official schema as a test fixture:
   - `parsePortableMcp(bytes)`: validates against `mcp.schema.json` and the semantic
     rules the schema does not encode (Agent Plugins §7.2.1, §9.2: `command` is one
     executable token, either a bare name or a `./`-relative path; placeholders are
     never expanded in `command`; `cwd` is `${PLUGIN_ROOT}`-rooted,
     `${PLUGIN_DATA}`-rooted or plugin-relative and stays inside that root; `env` may
     not name `PLUGIN_ROOT` or `PLUGIN_DATA`); `sse` is refused by name as unsupported;
   - `projectPortableMcp(parsed)`: the **static projection** — `type: "stdio"` →
     `transport: "stdio"`, `type: "streamable-http"` → `transport: "http"`, `cwd`
     carried (§3.2), `mcpAuth` merged in, and every path left **symbolic**: `command`
     stays bare or `./`-relative, `args`, `env` and `cwd` keep their `${PLUGIN_ROOT}` /
     `${PLUGIN_DATA}` placeholders and package-relative forms. It contains no absolute
     path, no generation or activation id, no server id and no secret. It is the
     representation the descriptor's authority is derived from (§5.2) and the one the
     Studio edits;
   - `resolveRuntimeMcp(static, { generationRoot, dataDir, activation })`: the
     **runtime resolution**, run at preparation only — it anchors package paths and
     expands data paths through the placeholder adapter of §3.3 under the **MCP
     launcher policy** (the launcher grammar identifies the executable and the package
     or image tokens that stay literal), then builds what
     `plugin-mcp-projection.ts` builds today (the `plugin_<hash>` id, the approval, the
     anchored argv, `:112-134`, `:173-190`), with `cwd` added to the parser's allowed
     fields (`:72-76`). Nothing it produces enters a descriptor, a digest or an export;
   - `exportPortableMcp(static)`: the inverse of the static projection, writing
     `$schema` and `type` back, so an export is a portable file (P1-1 fixture: the round
     trip equals the input). It takes the static form, never the runtime one, which is
     why it can be written at all.
   The two vocabularies stay distinct on purpose: `type` is the portable word,
   `transport` the host's, and neither is relabelled.
6. **Unknown top-level fields and unknown `extensions` namespaces are reported and
   ignored; a namespace is never validated** (Agent Plugins §5.2, §8.1, §11.3). The
   host writes one diagnostic per unknown field or namespace per load, as the protocol design applies
   the same rule to the wire (protocol design §3.3). **The package tree is checked by
   kind after classification**: a plugin tree is held to the content rules of §5.2
   (size, count, allowed files; no executable outside a skill's `scripts/` and a
   server's package-local files) and a file in an unsupported component directory is
   rejected, naming the file (§2.2); an extension tree is the artifact the receipts cover,
   and a `ai.agent-connector.ave/` directory inside an extension is ignored with a diagnostic because
   an extension declares its contributions explicitly (§1.1).
7. **`${PLUGIN_ROOT}` and `${PLUGIN_DATA}`** are expanded in `mcp.json` `args`, `env`
   and `cwd` and set in the server's environment (Agent Plugins §9). `PLUGIN_ROOT` is
   the sealed generation directory of the installed package version; `PLUGIN_DATA` is
   `~/.ave/agent-plugin-data/<packageName>/`, one directory per installed package
   name, kept across updates and removed at uninstall only when the user chooses to
   remove data — the rule the `mcp` kind already has for `$DATA_DIR`
   (`src/marketplace/app/mcp-installer.ts:133-134`; marketplace design §5.2). How the
   directory reaches a running server is §3.2.

Portability follows: a package with only `plugin.json`, `skills/` and `mcp.json` loads
in Ave and in any other conformant client unchanged; a package with `ai.agent-connector.ave/` loads
elsewhere with that directory ignored; a package written for another client with its
own namespace loads in Ave with that namespace ignored.

### 2.2 Components supported at launch

| Component | Location | Format | Supported from |
|---|---|---|---|
| Skills | `skills/<name>/SKILL.md` | Agent Skills frontmatter `name`, `description`, optional `license`, `compatibility`, `metadata`, `allowed-tools` (source 2); the host's skill content rules apply per skill (`src/marketplace/content/rules.ts:48-52`); addressed by the package-qualified selector of §3.5 | slice C |
| MCP servers | `mcp.json` | the official `mcp.schema.json` shape of §2.1 item 5, constrained by the host's launcher grammar (§3.2) | slice C |
| Prompts | `ai.agent-connector.ave/prompts/<name>.md` | frontmatter `name` (`^[a-z][a-z0-9-]{0,62}$`), `description`, `kind: "template" \| "persona"`, optional `argumentHint`; body ≤ 8 KiB, the persona body limit (`src/main/persona-prompt-store.ts:19`). A **template** is a slash-picker entry that sends its body as one message with `{args}` replaced by the user's text; a **persona** is a system-prompt addition selectable per keyboard turn, the store that exists today (`src/main/persona-prompt-store.ts:1-8`), addressed by the package-qualified id of §3.5 | slice C |
| Agent profiles | `ai.agent-connector.ave/agents/<name>/AGENTS.md` | the `agent` kind's file (marketplace design §5.2) | slice C |
| Routine templates | `ai.agent-connector.ave/routines.json` | `{ "version": 1, "templates": [{ id, title, description, trigger: "schedule" \| "shutdown", schedule?, execution: "llm-session" \| "notification-only", prePrompt?, notificationTitle?, notificationBody?, suggestedScope?: { pluginIds: string[] } }] }` — the `AddRoutineInput` fields (`src/shared/routines-types.ts:147-170`) minus anything runtime-owned, with `id` matching `^[a-z][a-z0-9-]{0,62}$` and at most 8 templates. A template is a prefilled form, never a record (§3.4) | slice C |
| Hooks | `ai.agent-connector.ave/hooks.json` | the host's `hooks.json` shape (`src/hooks/hook-config.ts:49-70`): event keys from the closed set (`:91-110`), `command` in argv form only, optional `matcher`, `timeoutMs` clamped to `DEFAULT_HOOK_TIMEOUT_MS` (`src/hooks/script-hook-types.ts:261`); paths in the placeholder grammar of §3.3 | slice E |

Everything else a package may contain is rejected by the content rules, naming the
file, and never executed (`src/marketplace/content/rules.ts`). The rejections that are explicit because an author will look for
them:

| Not supported | Why |
|---|---|
| language-server declarations, output styles, workflows, monitors, `bin/` executables, plugin `settings.json`, `user_config` | Ave has no feature they would attach to; `bin/` and `user_config` would add an ambient executable path and a secret channel outside the host's stores. Rejected, naming the file |
| themes inside a plugin | themes are their own kind with their own token contract (marketplace design §5.5); a theme travels as a `theme` package |
| a second manifest location (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) | the loader reads the specification's root `plugin.json` only (Agent Plugins §5.1). A package that has only a client-specific manifest is handled by the importer (§2.4), which produces a root manifest the user reviews |
| hook types other than `command` (HTTP, MCP-tool, prompt, agent hooks) | the host's hook runner spawns argv (`src/hooks/hook-config.ts:64-66`); the other types would each be a new network or model surface. Rejected by name in the hooks parse diagnostics |
| `sse` MCP transport, `{variable}` templates, registry base URLs, extra launcher options | the same refusals the `mcp` kind makes (marketplace design §5.2); `sse` is optional in the specification and declined here |

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
| file name `commands/<name>.md` (or the path the legacy manifest declares for commands) | `ai.agent-connector.ave/prompts/<name>.md`, `kind: template` |
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
| `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` in `command`, `args`, `env` | `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`, the Agent Plugins placeholders (§9.2), under the §3.3 grammar |
| `${user_config.*}` | rejected: no secret or setting channel outside the host's stores |
| handler `type` other than `command` | rejected (§2.2) |

**What the mapping does not translate, stated.** Event names and argv are mapped; the
stdin payload, the decision protocol (exit codes, JSON output fields) and matcher
semantics are the host's own (`src/hooks/script-hook-types.ts:74-86`; the runner's
stdin envelope and result parsing, `src/hooks/script-hook-runner.ts:154-176`). A script
written against another host's protocol will not behave the same. The importer
therefore marks every imported hook entry `needsAdaptation: true` in the draft, the
review page shows the entry with that flag and the difference named, and the entry is
written into `ai.agent-connector.ave/hooks.json` only after the user clears the flag. There is no
adapter, because emulating another host's stdin and output contract would be a second
hook protocol to maintain.

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

1. root `plugin.json` whose `$schema` is the Agent Plugins schema — a portable package.
   **Only the portable files are read**: `plugin.json`, `skills/`, `mcp.json` and
   `ai.agent-connector.ave/`. Any legacy projection present beside them (`.claude-plugin/`,
   `.codex-plugin/`, `.mcp.json`, `commands/`, `agents/`, `hooks/`) is ignored with one
   diagnostic listing the ignored paths. This is the precedence rule that makes an
   export carrying an optional projection (below) re-import cleanly: canonical portable
   files win, nothing is read twice.
2. `.claude-plugin/plugin.json` and no root manifest — the Claude Code layout (source 3).
   The importer:
   - **synthesizes** the root manifest: `$schema` is always written as the Agent
     Plugins identifier (the source may omit it or carry another); `name` copied;
     `version` copied when present, otherwise the draft is marked `versionMissing` and
     the review page requires the user to enter one (the studio suggests `0.1.0`;
     nothing validates without it, §4.4); `description` likewise required at review;
     `author`, `homepage`, `repository`, `license`, `keywords` copied when present;
     every other key dropped with a diagnostic;
   - **reads the component locations the legacy manifest declares, combined with the
     defaults the way that host combines them** (source 3, "How each key combines with
     its default location"); a declared path is read from where it points, an inline
     definition is written to the corresponding Ave file:

     | Legacy key | Combination rule applied by the importer |
     |---|---|
     | `skills` | **adds** to the default: `skills/` is scanned and every declared directory is scanned too |
     | `commands`, `agents` | **replaces** the default: when the key is set, `commands/` (or `agents/`) is not scanned unless the declaration lists it; a declared command map (`source` or inline `content`) yields one template prompt per entry |
     | `hooks` | **merges**: `hooks/hooks.json` is read first when it exists, then every declared file or inline object is merged into it |
     | `mcpServers` | **merges**: `.mcp.json` is read first when it exists, then every declared file or inline map is merged into it; a later server with the same name replaces the earlier one, and the diagnostic names both |
     | any other component key (`outputStyles`, `workflows`, `lspServers`, `monitors`, `themes`, `settings`, `userConfig`, `channels`, `dependencies`) | not imported; one diagnostic per key (§2.2) |
   - maps `skills/` (or a root `SKILL.md`, which that layout treats as a single skill)
     to `skills/`, commands to template prompts (§2.3), `agents/*.md` to
     `ai.agent-connector.ave/agents/<name>/AGENTS.md`, hooks per §2.3 with `needsAdaptation`;
   - converts the merged legacy MCP servers to the portable `mcp.json`: `$schema`
     inserted; `type` decided by one rule table — legacy `type: "stdio"` or no `type`
     with `command` → `"stdio"`; legacy `type: "http"` or no `type` with `url` →
     `"streamable-http"`; legacy `type: "sse"`, `"ws"` or any other value → the entry
     is dropped with a diagnostic naming the unsupported transport; `command` present
     together with `url` → dropped as ambiguous;
     `command`/`args`/`env`/`url`/`headers` kept; `${CLAUDE_PLUGIN_ROOT}` and
     `${CLAUDE_PLUGIN_DATA}` rewritten; a placeholder in `command` rewritten to the
     `./`-relative form when it names a package file, otherwise refused; `oauth` and
     any other field dropped with a diagnostic. Renaming the file alone is not a
     conversion (source 5 says the same for its own layout).
3. `.codex-plugin/plugin.json` and no root manifest — the compatibility overlay of
   source 5: the same as 2 for the manifest and the MCP file (`.mcp.json` in that
   layout); that layout's `hooks/` directory is not read (see the note at the end).
4. otherwise the input is not a plugin; the studio says which files it looked for.

Every dropped, rewritten or synthesized item is a diagnostic on the draft, grouped as
*lost*, *rewritten*, *needs your input*; the review page shows the three groups before
the file list. The importer never fetches anything the package references, never runs
a script, and writes only under the studio's draft directory (§4.3). Its result is a
draft; the user installs it through the ordinary review sheet.

**Export** writes an Agent Plugins directory from an installed or drafted plugin:
`plugin.json`, `skills/`, `mcp.json` (through `exportPortableMcp`, §2.1 item 5),
`ai.agent-connector.ave/`, plus a `ave-package.json` descriptor (§5.2), the provenance file of
§4.3 and `LICENSE` if the author set one. One optional projection for the legacy
layout of source 3 may be written next to the portable files, never instead of them:
`.claude-plugin/plugin.json` (`name`, `version`, `description`, `author`),
`commands/<name>.md` for each template prompt (`{args}` → `$ARGUMENTS`),
`agents/<name>.md`, `.mcp.json` from `mcp.json` (placeholders rewritten, `type`
dropped), `hooks/hooks.json` from `ai.agent-connector.ave/hooks.json` with the event names mapped
back and the protocol difference stated in a comment file beside it. A host that reads
the portable root (source 5) needs nothing extra.

Routines and persona prompts have no equivalent elsewhere and stay under `ai.agent-connector.ave/`.
Secrets are never exported (§3.2): a server whose `mcpAuth` names a key is exported with
the declaration and without the value, and the export test asserts the absence of any
value that the secret store holds for the package.

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

Two component classes in a plugin run code, and both are named as such everywhere the
user meets them: an **MCP server** (a child process or a network peer, §3.2) and a
**hook** (a command the host runs on its own events, §3.3). Each is consented to
separately, by exact fingerprint, and each runs under the confinement that section
states. A plugin never causes an unattended turn: a routine is created only by the
user (§3.4). Everything else a plugin contains is text the host reads.

### 3.2 MCP servers

**Admission.** Each `mcp.json` entry is parsed, statically projected (§2.1 item 5) and,
at preparation, runtime-resolved into what the extension-bundled projection builds today
(`src/mcp/plugin-mcp-projection.ts:112-134`):
a server id `plugin_<hash>` derived from the package name, version, generation, local id
and fingerprint (and, for stdio, the activation id, so a successor never inherits a
process rooted in a retired payload); an approval with `allowedCommands: [command]`
(stdio) or `allowedUrls: [hostname]` (http), `allowedCapabilities: ["tools"]`,
`maxTools: 64`, and a tool name prefix derived from the package. Each projected tool follows the permission decision tree: read-only hints allow; other tools ask on first use with per-tool memory, or enter automatic review in auto mode. The approval is registered only after the user has approved that exact
fingerprint in the package sheet, recorded in the `mcpServer` trust store whose records
never transfer across versions (`src/plugins/plugin-contribution-trust.ts:5`, `:21-28`);
an update re-asks. From 0.13.0 an update re-asks only for a server whose approval digest
changed or cannot be determined; the approval digest covers the declaration, the files its
command names and every file of the package (only `plugin.json`'s `version` is ignored), and
an unchanged one keeps its approval into the new generation (marketplace design §18.7.3, decision 18 here). Preparation is the manager's bundled path: a scoped governance view
is built from the projection's approval and the candidate is connected before its
approvals are published atomically (`src/mcp/mcp-manager.ts:338-351`;
`src/mcp/mcp-governance.ts:421-427`, `:451-475`). Governance is asked again at connect
(`validateServer`, `mcp-governance.ts:168-178`), as it is for a marketplace `mcp` install
(`src/marketplace/app/mcp-installer.ts:194-197`, `PACKAGE_POLICY_BLOCKED`). The global
server cap counts runtime approvals (`mcp-governance.ts:187`).

**Organization switch.** `globalRules.allowUserApprovedServers: boolean` is added to the
governance policy file (`src/mcp/mcp-governance.ts:77-84` holds `globalRules`), default
`true`, together with `bundledServers: [{ package: "<kind>/<name>", server: "<localId>",
fingerprint }]`, a fingerprint allow-list through which an organization approves a
bundled server whose runtime id it cannot know (a bundled id changes with its
generation, so it is never listed in `policy.servers`, and the collision check `:406-408`
keeps meaning "a managed id is never a bundled id"). Every runtime approval carries a
`provenance: "user" | "policy-fingerprint"` field (the approval record already has
`approvedBy`, `src/mcp/types.ts:28`; the provenance is a closed discriminant beside it).
**One predicate** decides whether an approval is admitted, and it is the only rule the
lookup, the insertions, reuse, publication and reload apply:

```ts
admitted(a) =
     a is in policy.servers                                                     // managed
  || (a.provenance === "policy-fingerprint" && a.fingerprint is still listed in policy.bundledServers)
  || (a.provenance === "user" && policy.globalRules.allowUserApprovedServers)
```

- **Lookup.** `findApproval` (`mcp-governance.ts:482-484`, today managed list then
  runtime map) returns a runtime approval only when `admitted` holds for it. Every
  validation and capability check goes through it (`:175`, `:259`, `:329`, `:391`,
  `:401`), so a user approval with the rule `false`, or a policy-fingerprint approval
  whose fingerprint was removed from the list, fails Layer 1 at `validateServer`
  wherever it is asked — connect, reconnect, tool call, a reused client — and a
  policy-fingerprint approval whose fingerprint is still listed is returned with the
  rule `false`, which is what makes it usable.
- **Insertion.** `registerRuntimeApproval` (`:405-414`), `scopedRuntimeApproval`
  (`:421-427`), `replaceRuntimeApprovals` (`:431-447`) and `prepareRuntimeApprovals`
  (`:451-475`) throw `runtime approval not admitted by policy` for an approval that
  `admitted` rejects. Because `scopedRuntimeApproval` runs before the client is
  constructed (`mcp-manager.ts:338-343`), a refused preparation spawns nothing and
  connects nothing. The manager additionally evaluates `admitted` before starting
  bundled candidate discovery and records the component as `blocked-by-policy` in the
  package sheet, so the throw is a guard, not the UX.
- **Publication rechecks.** `prepareRuntimeApprovals` builds a snapshot before
  connection; its `publish()` re-evaluates `admitted` against the policy **current at
  publication**, not the one the snapshot was prepared under, and refuses (the manager
  then disconnects the prepared candidates) when a policy reload in between withdrew
  admission. A prepared snapshot never carries a stale exemption forward.
- **A change while servers run.** Governance reloads its policy on the refresh interval
  (`mcp-governance.ts:135`) or on an explicit reload. After every reload the manager
  re-evaluates `admitted` for every active runtime approval — by provenance, not by
  membership in the managed-id list — and disconnects every client whose approval is
  no longer admitted (user approvals when the rule turned `false`; policy-fingerprint
  approvals whose fingerprint left the list), reused clients included, unregisters
  those approvals, and marks their components `blocked-by-policy`. Approvals that are
  still admitted are untouched. When admission returns (the rule set back to `true`, a
  fingerprint re-listed), nothing reconnects by itself: the user re-enables the
  component; the fingerprint consent persists, so no re-consent is needed.
- **Consent.** A policy-fingerprint approval needs no user consent (the package sheet
  says "approved by your organization"); an update with a new fingerprint is unapproved
  again until the list is updated, and the per-fingerprint component consent and the
  stored-credential disclosure below stay on the same sheet.
- **Tests, on the manager path**: with the rule `false`, preparing a user-approved
  bundled server constructs no `McpClient` and calls no `connect`; a bundled server
  whose fingerprint is listed in `bundledServers` connects with the rule `false`,
  survives a reload with the rule `false`, and its tools stay callable; flipping the
  rule while a user-approved server is connected disconnects it and blocks its tools
  while the policy-approved one beside it keeps running; removing a fingerprint from
  the list disconnects that server; a snapshot prepared under `true` and published
  after a reload to `false` is refused; an extension's bundled server behaves
  identically, because the path is shared.

**Launcher grammar.** A stdio `command` is one executable token (Agent Plugins §7.2.1):
`npx`, `uvx` or `docker` with the pinned forms of the marketplace design (§5.2: exact
version, no registry option, tagged or digested image); `node` or `bun` whose first
argument is `${PLUGIN_ROOT}/<path>` to a file inside the package; or a `./`-relative
path naming an executable inside the package, the form the `mcp` kind's `server/`
directory already admits (marketplace design §5.2). A placeholder in `command`, a bare
`python`, a path outside the package, `..`, `\`, `:` or a control character is refused
with the entry named. `env` keys and values follow the reserved-name rules of
`src/mcp/safe-names.ts` and the launcher-variable exclusions of the marketplace design
(§5.2); `env` values are visible package data and may not carry a secret (Agent Plugins
§9.2).

**Working directory and data.** `cwd` is part of the projection: the portable parser
validates it (§2.1 item 5), `plugin-mcp-projection.ts` admits it (its allowed-field set,
`:72-76`, grows by `cwd`), the kind's `McpServerSpec` in the descriptor carries it, and
both spawn paths honour it — the plain spawn passes `cwd` (today it passes none,
`src/mcp/mcp-client.ts:2176-2181`), and the ASRT-wrapped spawn runs its command line in
`cwd`. The default `cwd` is `${PLUGIN_ROOT}` (Agent Plugins §7.2.1). `PLUGIN_DATA`
(§2.1 item 7) is created at first activation, set in the environment, and — this is the
step that makes it writable — added to the wrapped process's write grant beside the
process home and the generation `sandboxRoot` (`mcp-client.ts:2213-2228`;
`mcp-manager.ts:338-342` supplies the generation root). The grant is that one
directory; the sensitive read and write deny floors (`mcp-client.ts:2244-2249`) are
restated unchanged. `PLUGIN_DATA` is keyed by package name, not generation, so an update
or restart finds the same directory. Tests: a server writes a marker through
`PLUGIN_DATA`, the plugin is updated to a new version and restarted, and the marker is
read back — on the plain path and on the wrapped path; a `cwd` outside the two roots is
refused at parse.

**Secrets.** `mcp.json` has no secret field by design. A plugin whose server needs a
credential declares it in the manifest's plugin branch:

```jsonc
"extensions": { "ai.agent-connector.ave": {
  "mcpAuth": { "<serverName>": { "auth": "api-key", "apiKeyEnv": "EXAMPLE_TOKEN" } }   // or apiKeyHeader for http
} }
```

The declaration is the `auth`/`apiKeyEnv`/`apiKeyHeader` triple `McpRuntimeSpec` already
carries (`src/plugins/mcp-runtime-spec.ts:34-75`). The **value** is handled by a new,
explicit path, because the existing one does not fit: today's `setApiKey` finds a server
in the persisted config list and writes the whole list back as plain JSON
(`src/mcp/mcp-manager.ts:792-835`, `saveConfigs` `:926-930`); a bundled server is not a
persisted config entry and its stdio id changes with every activation
(`plugin-mcp-projection.ts:112-134`). The design:

- **Storage.** The value is written to the host's encrypted secret document store
  (`src/data/secret-document-store.ts:26-39`, `:381`, the store behind the marketplace
  git tokens `marketplace.gitToken.<host>`, `src/ipc/domains/git-marketplace.ts:111`)
  under the key `mcp.bundled:` followed by the JSON array
  `["<kind>","<packageName>","<serverName>"]` — a segment encoding, so a package name
  and a server name can never be split ambiguously whatever characters they carry
  (the store accepts any key without a NUL byte up to 1,024 characters,
  `secret-document-store.ts:239-245`). The key is the stable installed identity; it
  does not contain the version, generation or activation id. Lookup and write are
  host-owned: no plugin text gains a secret-read API. In packaged policy the store
  refuses to write when encryption is unavailable (`:527-533`); the persistence tests
  below run under that policy, because development policy may store plaintext.
- **Entry.** MCP settings shows the plugin's server with a "credential" field the way a
  marketplace `mcp` package's server has one. Saving calls a new manager method
  `setBundledApiKey(packageRef, serverName, value)` that validates the declaration,
  writes the secret store and reconnects that server; nothing goes through `setApiKey`
  or `saveConfigs`.
- **Injection.** At preparation the manager resolves the key for each projected server
  and sets `apiKey` on the in-memory `connectConfig` (`mcp-manager.ts:338-342`, where
  `sandboxRoot` is added the same way); the client injects it as it does today
  (`src/mcp/mcp-client.ts:2141-2145`). The value never enters a projection that is
  persisted, logged, exported or sent over IPC (`toConfigDto` keeps secrets write-only,
  `mcp-manager.ts:933-940`).
- **Lifecycle.** The runtime approval stays generation-bound; the credential is not. An
  update keeps the credential as long as the new manifest declares the same `auth` and
  the same `apiKeyEnv`/`apiKeyHeader` for that server name; a changed declaration drops
  the value and re-asks. Uninstall removes the key together with `PLUGIN_DATA` when the
  user chooses to remove data, and keeps it otherwise. A source switch (the same package
  name installed from another source) keeps the key, because the identity is the
  installed package name; the sheet says a credential is stored and offers to clear it.
- **Studio.** The studio's editable projection of a configured connector (§4.1) is the
  DTO with secrets removed; it never sees the value. Copying a hand-added server's
  `env` and `args` is not proof that no secret is embedded, so the studio shows every
  `env` value and every `args` token verbatim and requires the user to confirm each
  before it is copied, the advisory lint (§4.6) flags high-entropy tokens, and the
  export test of §2.4 asserts the absence of stored values.
- **Tests** (packaged secret policy). Persistence bytes contain no plaintext value;
  reconnect after restart injects the value; an activation-id change does not lose it;
  export contains no value; `setApiKey` on a bundled id is refused with the new method
  named.

A server named in `mcpAuth` that is not in `mcp.json`, or a second secret for one
server, is a schema error.

**Sandbox and egress.** A plugin's stdio server is spawned by the MCP client: with the
OS sandbox on it is wrapped by ASRT and fails closed if the wrap cannot be produced
(`src/mcp/mcp-client.ts:2156-2172`), with the centralized sensitive read and write deny
lists (`:2244-2249`) and the write grant of this section; with the sandbox off it is a
plain spawn (`:2176-2181`), which is the confinement class every MCP server and every
extension child has with the sandbox off (protocol design §13, decision 3). On Windows
the wrapped stdio path refuses (`:2203-2209`), so with the sandbox on a plugin's stdio
server does not start there, and the package sheet says so. Its network egress is the
sandbox's shared egress allow-list when wrapped and unconstrained when not. An http
server's URL is held to the approval's hostname and HTTPS by governance
(`mcp-governance.ts:198-226`) and to the public-network rule by the client's
NetworkGuard at open (`mcp-client.ts:2539-2546`; `src/core/network-guard.ts:318`,
`ensurePublicHttpUrl`), which the package cannot switch off because
`allowPrivateNetworks` is not a field a package may set (marketplace design §5.2).
`hostFetch` and its Tier A rules do not apply, because an MCP server is not a HostApi
peer and has no lease; that is not a weaker path but a different one, and the package
sheet states which confinement the server will run under, as the Doctor states it for
extensions (protocol design §13, decision 3).

**Trust tier.** `low`, like every MCP server (`src/tools/types.ts:83-90`;
`docs/architecture/architecture.md:1054-1057`). The plugin label does not raise it, and
the parity invariant (`architecture.md:1044-1060`) is untouched: the tools register
through the same adapter and execute through the same `ToolExecutor` stages.

### 3.3 Hooks

A hook is code the host runs. Today's runner spawns every hook directly — argv without a
shell, or a single `.sh` through the resolved interpreter
(`src/hooks/script-hook-runner.ts:231-246`, `:258-270`) — in the caller's cwd or the
process cwd (`:198`), with the allow-listed environment plus the `AVE_HOOK_*` fields
(`:154-176`; `src/tools/safe-env.ts:21-52`), under a timeout and output caps. It has no
sandbox branch: a hook script can read any file, open any socket and start any program
its OS user can, whether or not the OS sandbox is on. Anchoring its first path to the
package (`src/plugins/plugin-bundled-command.ts:27-49`) does not change that. Slice E
therefore does not "reuse the runner unchanged"; it adds the confinement below, and the
consent sheet describes what actually holds.

**Confinement policy for bundled hooks (decision 26).** A hook that comes from a package
— a plugin's `ai.agent-connector.ave/hooks.json` or an extension's bundled `hooks.json` — runs under
the same confinement class as a bundled MCP stdio server:

- **Sandbox on**: the argv is wrapped through ASRT's `wrapWorkerCommand`
  (`src/permissions/asrt-sandbox.ts:1337`; the branch the MCP client takes,
  `src/mcp/mcp-client.ts:2156-2172`), with write access to a fresh process home and the
  package's `PLUGIN_DATA` only, the centralized read and write deny floors restated
  (`:2244-2249`), and the sandbox's egress allow-list. The read model is what ASRT's
  is: a **deny-list** of known-sensitive paths (`~/.ave/secrets`, `~/.ssh`, `~/.aws`,
  the Ave namespaces of `src/permissions/sensitive-paths.ts:216-247`, …), not a read
  jail — a wrapped hook can read ordinary files the user can read, and the consent
  sheet says "cannot read your secrets, keys or credential directories", never "cannot
  read your files". A wrap that cannot be produced **fails closed**: the hook does not
  run, the event proceeds as if the hook were absent for observe-only events and is
  **denied** for **every** blocking event — each event whose result carries a decision
  (`UserPromptSubmit`, `pre`, `perm`, and any event the closed set marks blocking,
  `src/hooks/script-hook-types.ts:74-86`, `:92`) — and the result carries
  `denied: sandbox unavailable`. On Windows, where the wrapped path refuses
  (`mcp-client.ts:2203-2209`), bundled hooks do not run with the sandbox on, and the
  package sheet says so before consent.
- **Sandbox off**: a plain spawn, the class every MCP server and extension child has
  with the sandbox off (protocol design §13, decision 3). The consent sheet then says,
  in those words, that the hook runs with the user's own permissions and no OS
  confinement; the sheet never says "confined" for a spawn that is not.
- **User hooks** in `~/.config/ave/hooks` and the user's own `hooks.json` keep today's
  behaviour: they are the user's scripts, and changing them is outside this design.

The wrap is lifted out of the MCP client into one shared helper (`src/sandbox/`, used
by both spawn sites) so that the two cannot drift; the hook runner gains a
`confinement: { kind: "bundled", dataDir, generationRoot }` option, and a hook
invocation without it is a user hook.

**Exact spawn contract for a bundled hook**: `cwd` = the package's sealed generation
root (`PLUGIN_ROOT`); environment = `buildSafeChildEnv` (`safe-env.ts:21-52`) plus
`AVE_HOOK_*` (`script-hook-runner.ts:154-176`) plus `PLUGIN_ROOT` and `PLUGIN_DATA`;
stdin = the DLP-redacted envelope as today; timeout and output caps as today
(`src/hooks/script-hook-types.ts:261`, `:264`).

**Placeholders and anchoring: the adapter.** `anchorBundledCommand` examines **every**
path-like token of the argv it is given (`plugin-bundled-command.ts:31-42`, with
`looksLikePath` at `:7-9`: a token that starts with `.` or `~` or contains a separator),
rejects absolute tokens (`:34-35`) and resolves the rest against the descriptor's
directory. Handing it an argv that still contains a `${PLUGIN_DATA}/…` token therefore
throws (`command path is not a retained package file`), and expanding that token first
throws too (absolute). Neither "rewrite, anchor, then expand" nor "expand, then anchor"
works on the whole argv; the invocation is constructed by a placeholder-aware adapter,
`resolveBundledArgv`, used for hooks and for the portable MCP `command`/`args`/`env`/
`cwd` alike (§2.1 item 5, runtime resolution):

The adapter takes an **executable policy** from its caller, and the two callers have
different ones, because a hook and an MCP server are admitted by different grammars:

- *hook policy*: `command[0]` must be a package path, or `node`/`bun` followed by a
  package path; every other token is a package path, a data reference or a plain
  literal as classified below. A hook never names a registry package or an image.
- *MCP launcher policy*: the launcher grammar of §3.2 (marketplace design §5.2) has
  already validated the argv before the adapter runs, and it hands the adapter what it
  found: the executable (`npx`, `uvx`, `docker`, `node`, `bun`, or a `./`-relative
  package path) and the indexes of the **launcher literals**, which are exactly three
  things and nothing else: the pinned registry package spec for `npx` and `uvx`
  (`example-server@1.2.3`, `@example/server@1.2.3`, `package[extras]==1.2.3`); the
  image reference for `docker` (`ghcr.io/example/server:1.2.3`,
  `example/server@sha256:…`); and the fixed option tokens the grammar allows (`-y`,
  `--from`, `run`, `-i`, `--rm`, `-e NAME`, `--network none`). **A launcher literal is
  never a local path.** The script token that follows `node` or `bun` is a **package
  path**, not a literal: it is classified, `${PLUGIN_ROOT}`-rewritten, anchored to the
  package root, sealed and hashed exactly like any other package-path token, so the
  program the sheet shows is a retained package file and not a name the runtime
  resolves. Launcher-literal indexes are copied through verbatim and are exempt from
  the path-shape refusal, because a scoped package name and a namespaced image contain
  `/` and `looksLikePath` (`plugin-bundled-command.ts:7-9`) would otherwise call them
  paths. Everything after the package or image belongs to the server and is classified
  below.

Placeholder resolution and indexed anchoring (steps 2–4) are shared; only the
classification of `command[0]` and of the grammar-identified literals differs.

1. **Classify every token** of the symbolic argv into exactly one class:
   - *launcher literal* (MCP policy only): a registry package spec, an image reference
     or a fixed option token whose index the launcher grammar identified — copied
     through verbatim, never anchored, never expanded; never a local path;
   - *package path*: `${PLUGIN_ROOT}/<p>` or a `./`-relative token — rewritten to
     `./<p>` (the `./` is **kept**, so a root file such as `${PLUGIN_ROOT}/hook.js`
     becomes `./hook.js`, which `looksLikePath` recognizes and the anchoring pass seals
     and file-hashes; a bare `hook.js` would be skipped by `:33` and is never produced);
   - *data reference*: `${PLUGIN_DATA}` or `${PLUGIN_DATA}/<p>` — validated
     symbolically: `<p>` has no `..` segment, no absolute or drive-letter form, no
     `\`, no NUL; refused otherwise;
   - *literal*: everything else — a flag, a number, a word, a URL. A literal that
     looks like a path (`looksLikePath` true) or still contains `${` is **refused**:
     a bundled program may name a filesystem path only through the two placeholders,
     and a registry package or image only where the launcher grammar admits one.
   `command[0]` is held to the caller's executable policy; a data reference in
   `command[0]` is refused under both (Agent Plugins §9.2).
2. **Anchor package paths only.** `anchorBundledCommand` gains a parameter
   `anchorIndexes: readonly number[]`; the adapter passes the indexes of the package
   tokens and the **package root** as the descriptor directory (the plugin hook
   projection passes `plugin.json` as the descriptor path, not `ai.agent-connector.ave/hooks.json`).
   Tokens not listed are copied through verbatim by the helper, so a literal is
   preserved as written and a data reference is never seen by the anchoring pass. The
   helper's fingerprint covers the anchored package files as today (`:50-56`).
3. **Expand data references after anchoring**, replacing each with the absolute
   `PLUGIN_DATA` path and re-checking containment on the resolved result (`realpath`
   inside the data directory, a symlink out of it refused).
4. **Apply the confinement** of this section to the resolved argv.

The symbolic argv of step 1 (placeholders intact, `./`-relative package paths) is what
the descriptor authority hashes (§5.2) and what the consent sheet shows; the resolved
argv of step 3 exists only in the running host. Tests for the adapter, one fixture
file for both policies:

- *hook policy*: a package script with a data-path argument
  (`node ${PLUGIN_ROOT}/server/hook.js ${PLUGIN_DATA}/state.json` resolves, anchors
  `server/hook.js`, expands the second token); a root-file reference
  (`${PLUGIN_ROOT}/hook.js` → `./hook.js`, sealed and hashed); a literal with spaces
  preserved verbatim; `${PLUGIN_ROOT}/../x`, `${PLUGIN_DATA}/../x`, a bare path
  literal, a `${` left over, a data symlink that escapes, and `npx example@1.2.3` as a
  hook — each refused by name;
- *MCP launcher policy*, each run through the **complete path** from `mcp.json` bytes
  (parse, §2.1 item 5) to the resolved runtime config: pinned `npx` unscoped
  (`npx -y example-server@1.2.3 --data ${PLUGIN_DATA}/db`: literals kept, the data
  token expanded); pinned `npx` scoped (`npx -y @example/server@1.2.3`: the `/` in the
  package name is not a path); `uvx` (`uvx example-server==1.2.3` and
  `uvx --from example-server==1.2.3 example-cli`); a namespaced image by tag
  (`docker run -i --rm ghcr.io/example/server:1.2.3`) and by digest
  (`docker run -i --rm example/server@sha256:<64 hex>`); a package-local server
  (`./server/run` with `${PLUGIN_ROOT}/config.json` in `args`, anchored and hashed);
  a `node`/`bun` script as a package path (`node ${PLUGIN_ROOT}/server.js` and
  `bun ./server.ts` are anchored to the package root, sealed and hashed, and the
  resolved argv names the sealed file); and the refusals the grammar keeps:
  `npx example-server` unpinned, `example/server:latest`, a package spec that is a
  path or URL, `${PLUGIN_ROOT}/…` as `command`, `node ../escape.js` (escapes the
  package root) and `node /usr/lib/anything.js` (absolute script path).

What the program then does is bounded by the confinement above, not by the anchoring.

**Consent and tests.** The consent sheet shows the symbolic argv (step 1 above), the
event, the matcher, the timeout, and the confinement class the hook will run under on
this machine, with the read model stated as the deny-list it is. The exact-generation approval (`src/hooks/plugin-hook-projection.ts:14-31`)
does not survive a version change. Slice E's tests exercise denied effects, not only a
successful spawn: a wrapped hook that reads `~/.ssh` fails, one that writes outside
`PLUGIN_DATA` and the process home fails, one that opens a socket to a host outside the
egress allow-list fails, a wrap failure denies a blocking event and passes an observe-only
one, and a Windows run with the sandbox on refuses before spawn.

### 3.4 Routines: templates, not routines (owner decision 4)

A plugin ships **no routine that runs**. What it ships is a routine **template**
(§2.2) — a prefilled suggestion — and, typically, a skill that helps the user create the
routine in conversation. A routine comes into existence only through the routine-creation
flow the app already has, with that flow's approvals, and the user owns it. This is the
model the automations documentation of source 8 describes for scheduled tasks: the
task is the user's, created from a chat or by a skill, and the plugin that suggested it
is not its owner.

**Two ways to create one from a template, both existing flows:**

1. **Routines panel.** Templates from installed plugins are listed under the plugin's
   name with their title, description, schedule and, for `llm-session`, the full
   `prePrompt`. *Create routine…* opens the panel's ordinary add form **prefilled** from
   the template; the user edits anything, confirms the scope (a `suggestedScope` is
   shown as a suggestion and is never applied silently; the default is deny-all,
   `src/shared/routines-types.ts:100-108`), and submits through the same channel the
   form uses today (`ave:routines:add`, `src/shared/ipc-channels.ts:41`), with the
   store's caps (`src/main/routines-store.ts:374-386`).
2. **Conversation.** The user asks; the model, guided by the plugin's skill, calls the
   built-in `routine_schedule` tool (`src/tools/routine-schedule.ts:147-153`: `builtin`,
   `category: "write"`, approval-gated), and the user approves the proposed routine as
   they approve any `routine_schedule` call today.

In both cases the record's `source` field (`src/shared/routines-types.ts:144`, `:170`;
`routine-schedule.ts:200-203`) is set to `agent-plugin:<packageName>:<templateId>` for
**attribution only**: the panel shows "created from a template of *X*". The user may
edit, disable, delete or re-source the routine at will.

**Ownership rules, stated as prohibitions on the plugin.** A plugin cannot enable a
routine, update one, change its schedule, scope or prompt, dismiss it, abort a running
one, or revoke it. Disabling, updating, uninstalling or revoking the plugin (§5.5)
touches no routine: the record stays, the attribution label changes to "template no
longer installed", and the Routines panel offers the usual delete. A template that
changes in an update changes nothing already created. Because no routine execution is
bound to a package generation, there is nothing package-scoped to abort on revocation:
a running routine is the user's and behaves as every user routine does today — removing
it (`ave:routines:remove`, `ipc-channels.ts:43`) deletes the stored record
(`src/main/routines-store.ts:411-420`) and does **not** abort a turn the engine has
already started; that turn ends when `runTurn` returns, and no later run starts. This
page changes nothing about that behaviour. The scope predicate is unchanged: `pluginIds` restricts extension tools and
extension skills only (`src/tools/pipeline/plugin-turn-scope.ts:45-60`), and a routine
created from a template is held to the scope the user confirmed, exactly like one the
user typed.

### 3.5 Prompts, personas and skills

**Template prompts.** A template prompt is sent only by a user click, under a new
`ChatInputOrigin` value `plugin-prompt-emitted` beside `mcp-prompt-emitted`
(`src/shared/chat-origin.ts:24`), with the same consequences: never `user-keyboard`,
tool calls in that turn carry non-user provenance, and the leading-slash strip applies
(`src/shared/slash-sanitizer.ts:7-15`). Adding the enum value is a shared field-addition
sweep (AGENTS.md, "A shared payload field or enum literal requires a same-PR
field-addition sweep").

**Personas.** The persona store reads `id`-keyed local files under `~/.ave/prompts/`
(`src/main/persona-prompt-store.ts:18-19`, `:40-52`), and a persona is selected only on
a keyboard turn, through the user message's own metadata
(`src/ipc/handlers/chat.ts:216-229`, `:232-242`). Identity and provenance rules:

- a package persona is addressed as `agent-plugin:<packageName>:<name>` (the id
  allowlist `PERSONA_PROMPT_ID_ALLOWLIST`, `persona-prompt-store.ts:18`, grows to admit
  that form); the bare `<name>` space stays the user's, so a package can never shadow a
  local persona or another package's, and two packages with the same persona name
  coexist;
- the persona picker shows the package name beside the persona, and the role prompt
  addition the persona contributes is recorded with `origin: { kind: "agent-plugin",
  package, version }` next to the turn's provenance, so an audit row says whose text
  shaped the system prompt;
- the `user-keyboard` guard is **not** weakened: a template-prompt turn carries no
  persona selection (its origin is `plugin-prompt-emitted`), so a template and a persona
  from the same package never combine in one send. A user who wants both writes the
  keyboard turn with the persona selected; the template is a separate send.

**Skills.** A plugin skill is registered in the skill store's plugin-skill map
(`src/main/skill-store.ts:471`, the map `preparePluginGeneration` fills for extensions,
`:773-780`), not in the name-keyed package map (`:469-486`, where a name collision would
replace another package's skill). Its selector is `agent-plugin:<packageName>:<skill>`,
a third form beside the user name and the extension selector
`plugin:<pluginId>:<skill>` (`src/shared/plugin-skill-selector.ts:15-16`;
`SKILL_SELECTOR_ALLOWLIST`, `src/main/skill-store.ts:77-80`). Consequences: a bare
name always means a user skill; two packages with the same skill name coexist under
different selectors; the turn-scope predicate, which parses only the `plugin:` form
(`src/tools/pipeline/plugin-turn-scope.ts:45-60`), returns `null` for a plugin skill,
which is correct because a plugin owns no tools to scope; and `skill_load` keeps its
approval gate (`src/tools/skill-load.ts:158-167`, `:208-222`). Uninstalling the plugin
removes its skills from the map; nothing was copied into `~/.ave/skills/`.

---

## 4. No-code creation

### 4.1 What a user composes

A user builds a plugin from things the app already has, plus text the assistant helps
write:

| Part | Source in the app | What goes into the package |
|---|---|---|
| Skill | an installed skill (marketplace package or `~/.ave/skills/`), or a new one written in conversation | a copy of the skill directory (without `scripts/` for a studio-authored skill; an existing skill's `scripts/` are copied and flagged) |
| Routine template | an existing routine from the Routines panel, or a schedule described in conversation | a template with the routine's schedule, execution, prompt and a `suggestedScope`, minus run history and minus the record itself; the user's routine is untouched |
| Connector | an MCP server already configured in MCP settings (hand-added, marketplace-installed, or from another plugin) | its runtime spec, taken from the secret-free DTO, written as an `mcp.json` entry through `exportPortableMcp` and, if it has a key, an `mcpAuth` declaration; **never the key value**; every `env` value and `args` token confirmed by the user before it is copied (§3.2) |
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

### 4.3 Where the result is stored, and what provenance travels

```
~/.ave/studio/                     # openFeatureNamespace("studio"): 0o700 / 0o600
  <name>/
    package/                        # the Agent Plugins directory (§2)
    draft.json                      # { version: 1, name, createdAt, updatedAt,
                                    #   parts: [{ path, origin }],
                                    #   reviewed?: { treeDigest, at }, sharedAt? }
```

`parts[].origin` records where each file came from: `{ kind: "copied", from: { kind,
name, version } }` for a copied installed package, `{ kind: "user-store", path }` for a
user skill, prompt or profile, `{ kind: "conversation", sessionId }` for text the
assistant authored, `{ kind: "typed" }` for the form.

**What travels with the package.** The draft directory itself is never exported. The
provenance that leaves with the package is `ai.agent-connector.ave/provenance.json`
`{ version: 1, parts: [{ path, origin }] }` — the same list with every machine-local
value removed: `sessionId` is dropped, and a `user-store` origin is exported as the
logical identity `{ kind: "user-store", store: "skills" | "prompts" | "agents", name }`
instead of its absolute path, which stays in `draft.json` only, so a shared package
never carries a username or a private directory name — plus, where the format has a
place for it, `SKILL.md` `metadata` (a string map, Agent
Skills §frontmatter) and a prompt's frontmatter get `ave-origin: studio` and
`ave-authored-by: model | user`. This provenance is **author-declared**: the installer's
package sheet labels it "declared by the author, not verified" and shows it beside,
never instead of, the full texts. The install review (§4.6 item 4) is authoritative
whatever the provenance says.

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

- the manifest name is a package name (`src/marketplace/catalog/types.ts:26`), and
  `version` and `description` are present (a draft from an import may lack them, §2.4);
- every skill parses under the Agent Skills frontmatter rules and the skill content
  limits; a studio-authored skill has no `scripts/`;
- every prompt body is within the persona limit and, for a template, names each `{args}`
  it uses;
- every routine template is a valid prefill for `AddRoutineInput` and its schedule
  parses (`src/main/routines-store.ts:52-58` bounds; `isValidCronExpression`);
- every `mcp.json` entry passes the portable parser (§2.1 item 5), the launcher grammar
  and reserved-name rules (§3.2), and `mcpAuth` names only servers that exist;
- every hook entry has `needsAdaptation` cleared (§2.3);
- the advisory injection lint (§4.6) has run and its findings are attached.

A draft with an error cannot be installed or shared; a draft with warnings can, after
the user has seen them.

### 4.5 Sharing (owner decision 3)

Three ways, all starting from the review page's *Share*, and none of them has the app
commit or push:

1. **Export a file.** `<name>-<version>.zip` of the package directory plus its
   `ave-package.json`. Another user installs it through Settings → Marketplace →
   *Install from file*, which opens the same package sheet as a marketplace install with
   the file's contents as the descriptor and every component's consent (§3). The
   install is bound to no source and never updates.
2. **Write into a git marketplace checkout.** The studio writes the package as
   `agent-plugins/<name>/` (package directory plus descriptor) into a local checkout the
   user picks, and shows the exact next steps: run the repository's checker, commit,
   open a pull request. The app never commits and never pushes (owner decision 3): the
   marketplace's git contract is read-only by design (marketplace design §9.3 lists the
   commands it uses and nothing else), pushing would need write credentials and branch
   rules the app should not hold, and a merge to `main` is the publish (marketplace
   design §4.3). The official repository's index generator learns the new kind (§7,
   monorepo).
3. **Share inside a team.** A team's marketplace is a custom or managed source
   (marketplace design §12, `additional`); publishing to it is case 2. There is no
   in-app team channel: the Agent Hub service is decommissioned and the app has no server.

*Share* is available only while `draft.json.reviewed.treeDigest` equals the digest of
the current `package/` tree (§4.6 item 3).

### 4.6 Safety: model-authored content, prompt injection, and consent

The threat is a plugin whose text steers the model against the user who installs it:
a skill that says to read `~/.ave/secrets`, a routine template whose prompt asks to
mail a document somewhere, a template that starts with a host command. The controls, in
the order they apply:

1. **Nothing in a plugin can grant itself anything.** A skill is instructions inside a
   turn whose tools still pass Layer-1 deny, the ApprovalGate and audit
   (`architecture.md:1049-1053`); a routine created from a template runs under the
   routine policy lane with the scope the user confirmed; an MCP server is `low` trust;
   a prompt is non-keyboard provenance. The security control is the permission system,
   not the text review.
2. **Provenance is recorded** (§4.3): the review sheet says which parts were written by
   the model, which were copied from an installed package (with its version), and which
   the user typed; the installer sees it as author-declared.
3. **The author reviews before sharing, and the review is bound to the bytes.** *Share*
   shows every skill, prompt and routine template in full, with the advisory lint
   findings, and requires the author to confirm they read them; `draft.json.reviewed`
   is set to `{ treeDigest, at }`. Every write to `package/` — through the form or
   through a `plugin_studio_*` tool — recomputes the digest and clears `reviewed` when
   it changed, so a draft reviewed once and edited afterwards must be reviewed again.
   Export and write-into-checkout refuse without a current `reviewed`.
4. **The installer reviews before installing.** The package sheet shows the same full
   texts (not summaries), each MCP command and each hook argv verbatim with its
   confinement class, and asks for each code-executing component separately; routine
   templates are shown as templates, with the statement that nothing is scheduled by
   installing (§3.4).
5. **An advisory lint** runs over skills, prompts and routine prompts and flags, with the
   matched text: instructions to ignore or override prior instructions; requests to read
   `~/.ave`, `~/.ssh`, `~/.aws` or the secret store; requests to disable approvals,
   sandboxes or hooks; instructions to send content to a URL or address that the plugin
   does not otherwise name; a template body beginning with `/`; a high-entropy token in
   a connector's `env` or `args`. It is a warning surface for the two human reviews
   above, stated as such in the UI; it is not a gate and not a security control, because
   a heuristic that can be phrased around must not be presented as one.
6. **Revocation reaches shared packages** through the source that published them
   (§5.5); a file-shared package is revoked by the user who installed it.

---

## 5. The marketplace and catalog

### 5.1 Kinds and listing vocabulary

`PACKAGE_KINDS` (`src/marketplace/catalog/types.ts:12-22`) gains `agent-plugin`. The
existing literal `plugin` keeps its value and its meaning (a code package); only its label
changes (§6.1). The kind tab order (`labels.ts:17`) becomes Plugins (`agent-plugin`),
Extensions (`plugin`), MCP, Skills, Agents, Themes, Fonts, Languages, Providers,
Messaging: the kind an ordinary user is meant to find first is first. The reorder lands
with slice C, when the union member exists; slice B changes labels only (§7). The
conventional layout scans `agent-plugins/` beside `plugins/` (marketplace design §3.3);
a descriptor under `plugins/` that declares `agent-plugin`, or the reverse, is dropped
with a diagnostic like any directory–kind mismatch. The deep-link forms
`ave://install/<kind>/<name>@<source>` (`src/main/ave-protocol.ts:14`;
`src/shared/git-marketplace.ts:334`) and the policy lists
(`src/marketplace/sources/policy.ts:16`, `:38`) accept the new literal through
`isPackageKind` (`src/shared/git-marketplace.ts:445`).

The literal is `agent-plugin` and not `plugin`, `bundle` or `kit` because it names the
specification the package conforms to and reads correctly in every place a kind literal
appears (a directory name, a ledger row, a deep link, a policy entry), while leaving the
existing literal untouched (§6.2).

### 5.2 Descriptor and index changes

The descriptor for the new kind, in the amendment's format 2 (`schemaVersion: 2`,
amendment §6.4, decision 24):

```ts
// ave-package.json, kind "agent-plugin", schemaVersion 2
payload: {
  manifest: "plugin.json";                 // fixed
  components: AgentPluginComponents;       // derived from the package; the catalog reads it without downloading bytes
}

interface AgentPluginComponents {
  skills: Array<{ name: string; hasScripts: boolean; digest: string }>;
  mcpServers: Record<string, McpServerSpec & { cwd?: string; digest: string }>;   // the static projection of §2.1 item 5: symbolic paths, placeholders intact
  mcpAuth?: Record<string, { auth: "api-key"; apiKeyEnv?: string; apiKeyHeader?: string }>;
  prompts: Array<{ name: string; kind: "template" | "persona"; digest: string }>;
  agents: Array<{ name: string; digest: string }>;
  routineTemplates: Array<{
    id: string; title: string; trigger: "schedule" | "shutdown"; schedule?: string;
    execution: "llm-session" | "notification-only"; suggestedScope?: string[]; digest: string;   // digest covers prePrompt and every field
  }>;
  hooks: Array<{ event: string; matcher?: string; command: string[]; timeoutMs: number; digest: string }>;
}
```

**Canonical derivation: static authority, from package content only.** `components`
is computed from the package tree by one function shared by the app, the studio and the
repository checker, and it is **deterministic across machines**: the same package bytes
yield the same `components` on a publisher's checkout, in a Studio draft, in the
repository checker and on every installed generation. That holds because the derivation
reads only the **static** representation of each component and nothing the runtime
produces:

| Component | Canonical bytes hashed into `digest` |
|---|---|
| skill | every file under `skills/<name>/` in sorted path order, each as `<relative path>\0<sha256 of bytes>` |
| prompt, agent profile | the file bytes |
| routine template | the template object serialized with sorted keys |
| MCP server | the **static projection** of §2.1 item 5 serialized with sorted keys: `transport`, symbolic `command` (bare or `./`-relative), symbolic `args`, `env`, `cwd` and `url`/`headers` with placeholders intact, `mcpAuth` declaration, plus `<relative path>\0<sha256>` for every package file a package path names |
| hook | the entry serialized with sorted keys: event, matcher, the **symbolic argv** of §3.3 step 1, `timeoutMs`, plus `<relative path>\0<sha256>` for every package file a package path names |

Excluded by construction: absolute installation, data and home paths, sealed
generation paths, generation and activation ids, `plugin_<hash>` server ids, anchored
argv, and injected or stored secret values. The runtime projection
(`plugin-mcp-projection.ts:112-134`, `:173-190`; the adapter of §3.3) is derived
**from** the static form at preparation and never flows back into it. The descriptor's
`components` must equal the derived value; a difference is `MANIFEST_MISMATCH` at
install (marketplace design §6.2), and the repository check enforces the same equality
in CI. Tests: the same package under two different roots and two activation ids yields
byte-identical `components`; a real install of an unchanged package passes the
equality check; changing one byte of a referenced package file changes that
component's digest and no other.

**What the summary is for.** `components` plays the role `PluginAuthority` plays for
extensions (marketplace design §5.2): the index copies it into each `IndexVersion`, the
package sheet renders it before any download, and the update review shows the delta
(marketplace design §15.6) by component and by digest, so a routine template whose
prompt changed, a hook whose matcher or timeout changed, or a server whose `cwd`
changed is shown as changed even when its name did not. Re-approval on change: an MCP
server or hook whose digest changed is unapproved until the user approves the new
fingerprint (the trust stores already key on the exact generation, §3.2, §3.3); a
changed skill, prompt or profile is shown in the delta and activates without a separate
consent, because it is text the user chooses to load or send; a changed routine template
is shown and changes nothing already created (§3.4). The inventory alone is not the
authority; the digests are.

Content rules for the kind (`src/marketplace/content/rules.ts:48-101` gains a row):
8 MB total, 256 files; per-file rules are the union of the skill rules for `skills/**`,
`.json` and `.md` at the root and under `ai.agent-connector.ave/`, `AGENTS.md` under
`ai.agent-connector.ave/agents/`, and the `mcp` kind's `server/**` rules for package-local server
files; `LICENSE`, `NOTICE`, `CHANGELOG.md`, `README.md` allowed; SVG, links, devices and
escaping paths refused as for every content kind (marketplace design §5.4). Delivery is
the tree export, as for skills; the ledger records the tree digest (marketplace design
§5.5, §6.4). There is no artifact ladder: nothing in the package is compiled.

**Compatibility across apps.** A repository has one index, `marketplace.json`, with
its format version inside as `schemaVersion: 2`, and descriptors carry `schemaVersion: 2`
(marketplace design §4.2). The app reads that file only and refuses any other
`schemaVersion` with a message naming it. An app that knows the `agent-plugin` kind
offers the package, held to its `minAppVersion` through the ordinary `min_app_version`
exclusion (`src/marketplace/catalog/aggregate.ts`), so a later app that lacks a feature
the package's `requires.minAppVersion` names shows `upgrade_required`. An app whose
schema lacks the kind drops that entry alone with a diagnostic in the sync log; the rest
of the index stands. Apps before 0.12.0 refuse the file outright.

> Historical: until 2026-10-14 a frozen format-1 index beside the format-2 one served
> apps before 0.12.0, and this section described three app cohorts across the two files.

Slice C also moves the path claim in the index validator after **both** the per-entry
schema check and the semantic rules (`validate.ts:261-262` → after `indexPackageRules`,
`:267-270`), so that from the first release with C an entry that is dropped for any
reason never evicts a valid one; the fixtures "schema-invalid new-kind entry sharing a
path" and "schema-valid, rule-failing entry sharing a path" prove it. Older apps keep
the old order; the checker is their protection.

The trap a review found — renaming a kind literal or adding a field to a closed object,
which drops a whole package from every older client — is avoided by never touching the
`plugin` literal (§6.2) and never widening a closed object an older reader validates.

### 5.3 Install and activation

Install is the content path (marketplace design §5.5): write the files, then the ledger,
then activate; a failed activation restores the previous install. Activation registers,
in this order and each independently: skills into the skill store's plugin-skill map
(§3.5), persona prompts into the persona store under package-qualified ids, template
prompts into the slash picker's data, agent profiles into the agent store's package
layer, routine templates into the Routines panel as templates, then each MCP server
whose exact fingerprint the user approved (§3.2), then hooks likewise (§3.3). A
component that fails to register is reported and the rest stay active (Agent Plugins
§11.3 isolates component failures). Disable reverses activation and keeps the files;
uninstall removes the files and, when the user chooses, `PLUGIN_DATA` and the stored
credentials for its servers (§3.2). Routines the user created from its templates are
never touched (§3.4).

### 5.4 Direct install

A git URL whose root (or `subdir`) holds a `plugin.json` without `entry`/`process` is a
direct `agent-plugin` install (marketplace design §8.2 gains the branch): `name`,
`version`, `description` from the manifest (all three required here, §2.1 item 1),
`components` computed from the tree, `minAppVersion` from the plugin branch's `requires`
when present, else the first release that ships the kind; the descriptor must be
`schemaVersion: 2`. A root that holds only `.claude-plugin/plugin.json` or
`.codex-plugin/plugin.json` is refused as a direct install with a message that points at
*Import a plugin* (§2.4), because the package must be transformed and reviewed.

### 5.5 Revocation

`policy/revocations.json` and the app-version-conditional revocations (marketplace design
§10.4; alerts design "Retirement by revocation") apply to the new kind with no new field:
`kind: "agent-plugin"`, `name`, a version range, `disable` or `uninstall`. Disable
deactivates every component (§5.3) and stops the plugin's MCP servers and hooks; the
user is told why, as for every revoked package, and is told in the same notice that
routines they created from the plugin's templates are theirs and remain, with a link to
the Routines panel to review them (§3.4). Per-source scoping stays: a source revokes
only packages installed from it, a file-installed package has no source and is revoked
by its user.

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
  `gitMarketplace.ts:197`); and every other value among the 150 English catalog values
  that contain "plugin" (counted at `f1a8d191e` over `src/i18n/messages/generated/*.ts`,
  values only), reviewed one by one: a value about a code package says "extension", a
  value about the new kind says "plugin", and a value that is about both says
  "extensions and plugins". The `plugin` **keys** do not change (§6.2).
- **Korean strings** likewise, with **익스텐션** for extension and **플러그인** for plugin
  (owner decision 2). The two words are never used as translations of each other, and
  the established word 확장 is not used for either, so that a Korean reader meets exactly
  the two terms the English reader meets.
- **Documentation**: `docs/architecture/architecture.md` (the "Plugin Runtime" section
  and the parity invariant describe extensions), the plugin guides under `docs/guides/`
  (`plugin-development.md`, `local-plugin-development.md`, `plugin-version-quickref.md`,
  `marketplace-publishing.md`), the web documentation
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
| Plugin IDs (`^[a-z][a-z0-9-]*$`, `AGENTS.md:135`) | `meeting`, `mail`, … | They key the registry, the receipts, `~/.ave/plugins/<id>/` and its `data/`, host-secret grants (marketplace design §10.3), `pluginAccess` grants, alert kinds (`<pluginId>--<kind>`), routine scopes and audit rows. A rename is a data migration of every user's home directory for a word |
| Tool names (`^[a-zA-Z_][a-zA-Z0-9_]*$`) | unchanged | They are the model-facing surface and the permission rules' keys; the three namespaces stay distinct without runtime conversion (`AGENTS.md:189-190`) |
| IPC channels `ave:plugins:*`, `ave:marketplace:*` | unchanged | Locked by the channel inventory (`src/ipc/__tests__/channel-inventory.test.ts:1-8`) and the preload shape (`src/__tests__/preload-shape.test.ts:1-9`); a rename is a coherent handler/preload/type/caller/test change that buys nothing users see |
| `plugin.json` file name | unchanged | Agent Plugins §5.1 mandates it for both extensions and plugins; it is the specification's name, not Ave's |
| `extensions[...]` namespace mechanism | unchanged; the key moved once, to `ai.agent-connector.ave`, with 0.14.0's re-vendoring | The client namespace the specification reserves (§8); vendored by every extension repository and hash-checked (marketplace design §5.6). The proposal's separate extension-manifest filename (proposal §3.2) is rejected: the collision it feared is resolved by the namespace, which the manifest already uses (`public-contract.ts:38-39`, `:47`) |
| Install receipts (`installSource`, schema v3/v4, `artifactSha256`, `manifestSha256`) | unchanged | Persisted values that the grant chain and the Doctor read (marketplace design §2.3, §10.3); AGENTS.md treats shipped audit and persisted keys as migration decisions, not renames |
| Descriptor and index kind literal `plugin` | unchanged | Every snapshot, ledger row, policy `requiredInstalls[].kind`, deep link and index carries it; renaming it is the older-app trap of §5.2 |
| i18n **keys** (`sidebar.pluginsLabel`, `gitMarketplace.kind.plugin`, …) | unchanged | Keys are identifiers the catalog gates and the used-keys test match on (`src/i18n/__tests__/used-keys-exist.test.ts:35-62`); only values change |
| Code identifiers, module paths, types (`src/plugins/`, `PluginManifest`, `PluginHostApi`, `PluginContributionTrustStore`, `ave/host/*`, `hostProtocol`) | unchanged | AGENTS.md: do not rename unrelated code during another task; the protocol schema `$id`s and the vendored contract hash pin these names |
| Audit `type` keys, event namespaces (`plugin.*`, `host.*`) | unchanged | Persisted and subscribed values (`src/plugins/capabilities.ts:117-120`) |
| `OUT_OF_PROCESS_PLUGIN_IDS`, `PLUGIN_ENVELOPE_GRANTS` | unchanged | Being removed by the amendment's own steps (amendment §9.3, §9.6 slice C row); renaming a table scheduled for deletion is churn |

### 6.3 The existing eight packages become extensions with no reinstall

This is a vocabulary change, not a fresh-install guarantee. Classification is computed,
not stored: the loader reads `entry` from the installed manifest (§1.3) and the catalog
reads `kind: "plugin"` from the snapshot (§1.4). On the first boot of the release that
ships §7 slice B, every installed code package is an extension because its manifest has
`entry`; the registry, the receipts, the data directories, the contribution trust
records, the routine scopes and the alert kinds are untouched; the Sidebar group, the
settings tabs and the kind tab show the new word. No migration file is written, because
there is no state to migrate. The two external packages (the portal and repository plugins) still carry the
retired `publisher` / `installPolicy` fields in their installed manifests and load
through the existing strip-and-warn path (`src/plugins/runtime/manifest-validation.ts:98-119`),
which this design preserves (§2.1 item 3).

What this section does **not** promise: that an installed pre-0.12.0 artifact keeps
loading on 0.12.0. That is the amendment's cutoff (§6.4, "Cost, stated"): every code
package built before X is refused on X until republished with `hostProtocol: "2"` (on
0.14.0 and later the declaration is `"3"`, see Current contract). The
refusal and its update path are the amendment's, and the word "extension" changes
neither.

`hello-world` and `templates/plugin` are extensions like the others. The official
repository's `templates/plugin` directory is renamed `templates/extension` at the
republish wave (§6.4) because it is documentation for authors and the app never reads
it (marketplace design §3.2: "the client never reads them"); the amendment validates
and updates it in source at X (amendment §6.4, "Applicability"), and the rename rides
that update. The portal plugin (another marketplace source) and the repository plugin (its own repository) change their
README wording under this design; their republish with protocol 2 is the amendment's
requirement, not this page's, and happens regardless.

### 6.4 The Lease 0.12.0 cutoff: an opportunity, not a dependency

The amendment fixes app 0.12.0 as the protocol-2 boundary (decision 9) and republishes
every extension after its v0.11.0 alerts version (the 0.14.0 protocol-3 wave repeats this
with `"3"`), with `hostProtocol: "2"` and
`minAppVersion` 0.12.0, in the sequence of amendment §9.5 (candidates against a packaged
candidate app → app tag with a draft installer → re-vendor and publish every
replacement, pins and both index files → publish the draft → alias). This design has no
dependency on that wave and the wave has none on this design: an extension is an
extension whether it declares `"1"`, `"2"` or nothing, and the refusal of an undeclared
manifest on 0.12.0 is the amendment's rule, not this page's. The wave is the opportunity
to:

- update each extension's `description` and README to say "extension", since the
  package is being rebuilt and republished anyway;
- rename `templates/plugin` → `templates/extension` (§6.3) in the same monorepo change
  that re-vendors the contract;
- have the official generator's format-2 output (amendment §6.4, written at the wave
  regardless) carry the `agent-plugin` schema **if and only if** slice C is in the
  0.12.0 tag; otherwise the schema arrives with the second generator update of §7
  timeline 2.

The amendment's own host slices are A (design), B (dispatcher budgets), C (sandbox
authority end to end, which includes the manifest schema's public type and the format-2
reader), D (credential lease and egress cutover, the protocol-2 boundary), E1 (release
PR) and E2 (release runbook) (amendment §9.6). This page's slice C needs the amendment's
slice C on `main` and nothing later.

---

## 7. Release and slicing

Constraints: nothing lands in v0.11.0 (the alerts release, owner direction); the
amendment owns 0.12.0's protocol boundary and its own slices A–E2 (amendment §9.6);
each slice below is based on `main` after the previous merges and carries the
documentation for what it changes. Lock suites are named where a slice touches them.

| Slice | Scope | Focused gates | Lock suites |
|---|---|---|---|
| **A. Design** | this page; the superseded pointer on the 2026-08-16 proposal; the design README entry | markdown policy, naming gate against `origin/main`, link check of the citations | none |
| **B. Vocabulary and classification** (0.12.0, owner decision 1) | i18n values in `en` and `ko` for every "plugin" value that means a code package (§6.1: "extension" / 익스텐션), with keys unchanged; docs, web pages (with redirects), `resources/AGENTS.md`, `CHANGELOG.md` `## Unreleased`; a pure `isExtensionManifest(manifest)` in `src/plugins/` (true iff `entry` or `process` is present) used by the Sidebar group, the settings tabs, the Doctor labels and the package sheet section names. No kind-tab reorder (`KIND_ORDER` waits for the union member, slice C), no schema, IPC, settings or `package.json` change | `check:i18n-catalog`, `check:i18n-barrels` (`package.json:59`, `:62`; both run inside `build`, `:47`) and the used-keys test `src/i18n/__tests__/used-keys-exist.test.ts:35-62`, which proves every literal `t("…")` key resolves — it is the static gate a parity check lacks; a CDP run of the app from the worktree reading the sidebar, settings and marketplace tab text proves the rendered flow (computed keys and the actual strings); Playwright specs that assert labels; `bun run typecheck` | `channel-inventory`, `host-renderer-only-channels`, `domain-exports`, `preload-shape`, `settings-store` and `packaging-discipline-source` unchanged; naming gate |
| **C. The `agent-plugin` kind** | `PACKAGE_KINDS`, `schemas/marketplace/package.schema.json` and `index.schema.json`, descriptor `components` with canonical derivation and digests (§5.2), content rules, tree install and ledger, the validator's path-claim reorder (§5.2), activation of skills (plugin-skill map and selector, §3.5), prompts (both kinds, package-qualified persona ids, the `plugin-prompt-emitted` origin sweep), agent profiles, routine templates (panel prefill and `routine_schedule` attribution, §3.4) and MCP servers: the portable parser, static projection, runtime resolution and exporter (§2.1 item 5), the `resolveBundledArgv` adapter and `anchorIndexes` parameter (§3.3), `cwd` and `PLUGIN_DATA` on both spawn paths, the bundled credential store and `setBundledApiKey`, fingerprint approval, the `admitted` predicate with approval provenance, the `allowUserApprovedServers` rule and `bundledServers` list at the shared lookup, every insertion, publication and reload (§3.2); the static component authority and its derivation function (§5.2); the manifest schema's three-branch namespace block and root `required` (§2.1) and its public type; direct-install detection; deep-link and policy kind acceptance; `repository-check.ts`; package sheet Components section and update-review delta; kind tab order; the extension contribution set gains routine templates and prompts (§1.3, reason 2). **Lands after the amendment's slice C** (public type, format-2 reader). Uses the existing `ave:marketplace:*` channels; DTOs in `src/shared/git-marketplace.ts` grow | catalog validate fixtures for the kind (valid, each invalid rule, unknown keys, an unknown kind literal in the index → dropped per entry, malformed entry sharing a path → only that entry dropped, older-app snapshot unchanged); official `plugin.schema.json` and `mcp.schema.json` as fixtures (portable-only manifest, `streamable-http`, `./`-relative command, placeholder in `command` refused, `cwd` outside roots refused, export round trip); manifest `oneOf` fixtures (entry extension, process extension, plugin, malformed `entry`, both markers → refused); installed-manifest retired-field strip unchanged; content rules; content service activation and rollback; skill selector and collision fixtures; persona id and `user-keyboard` guard fixtures; routine template prefill and attribution, plugin removal leaves the routine; MCP: fingerprint, approval-not-transferring-across-versions, policy collision, `allowUserApprovedServers: false` → zero `McpClient` construction on the manager path, mid-run flip disconnects user approvals and leaves policy-fingerprint ones running, fingerprint removal disconnects, stale prepared snapshot refused at publication, `PLUGIN_DATA` marker survives update and restart on plain and wrapped paths, credential persistence bytes and reconnect under packaged secret policy, export contains no value; static authority: identical `components` under two roots and two activation ids, unchanged install passes equality, one changed file changes one digest; `mcpAuth` schema; direct-install branches; repository-check bundle rebuilt for the official repository; the git-marketplace lifecycle E2E adds one `agent-plugin` package with a skill, a prompt, a routine template and a stdio server | `src/shared/git-marketplace.ts` DTO tests; `preload-shape` only if the bridge grows a method (it does not: existing channels carry the kind); `settings-store` unchanged (routine templates are routines' prefill, not settings; the policy rule is in the governance file); `domain-exports` unchanged; `packaging-discipline-source` unchanged; manifest schema and hardening tests; naming gate |
| **D. Studio: create, import, export, install from file** | `~/.ave/studio/` namespace, `draft.json` with `reviewed: { treeDigest, at }` and `provenance.json`; the three `plugin_studio_*` tools; the form flow; the review page with the lost/rewritten/needs-input groups; import (§2.4, declared paths and inline definitions, synthesis, precedence, `needsAdaptation`) and export projections; *Install from file*; *Share* gated on the current `reviewed`; the advisory lint. One new IPC domain `ave:plugin-studio:*` (list/read/write drafts, validate, import, export, install-from-file) registered with its handlers, preload bridge, shared types, callers, sender guard and tests in one change (AGENTS.md, "A new IPC channel is one coherent change") | tool registry and executor parity tests for the three tools (approval-gated, `builtin`, `meta`); draft namespace permissions (`0o700`/`0o600`); import fixtures for each detection branch, each mapping row of §2.3, each synthesis and precedence rule of §2.4, including every rejection; export round trip (export → import equals the source package, with and without the optional projection); `reviewed` cleared on every write path; lint fixtures; install-from-file goes through the package sheet and records `sourceId: null`; a Playwright spec for form → review → install | **`channel-inventory`, `host-renderer-only-channels`, `domain-exports`, `preload-shape`, `preload` updated in the same change**; `settings-store` unchanged (no setting); `packaging-discipline-source` unchanged unless a script is added (none planned); naming gate |
| **E. Hooks in plugins** | the shared ASRT wrap helper used by the MCP client and the hook runner; the runner's `confinement` option and bundled-hook spawn contract (§3.3); the hook side of the `resolveBundledArgv` adapter (the adapter itself and `anchorIndexes` land in slice C for MCP); the package sheet's hook consent with the confinement class; export/import of hooks (§2.3) | hook parse and rejection fixtures per §2.3 row; the adapter fixtures of §3.3 (data-path argument, root file, spaces, escaped roots, bare path literal, leftover `${`, escaping data symlink); exact-generation approval and re-ask on update; runner timeout and output caps; denied-effect tests (read `~/.ssh`, write outside the grant, socket outside the allow-list), wrap-failure denies a blocking event, Windows sandbox-on refusal; a real spawned hook in the macOS and Linux CI jobs; the MCP client's wrapped-path tests unchanged after the helper extraction | hook registry and trust tests; MCP client wrap tests; no channel, preload, settings or script change; naming gate |

Validation discipline follows the repository contract (`AGENTS.md`, "Validation:
proportional during work, complete once at publish"): narrow vitest runs and
`bun run typecheck` while iterating; the complete run — typecheck gate, `bun run test`,
`bun run build`, `check:gate-core` — happens **once**, on the main + PR merged tree before merge (the pre-push hook
runs its fast tier, `scripts/hooks/run-local-checks.mjs`), not as a separate ritual before it; CI
`build-and-test` and `naming-gate` green on the check rollup before merge; and
`.github/scripts/naming-gate.sh origin/main HEAD` locally with GNU grep
(`naming-gate.sh:25` fails closed without PCRE).

**Plugin and monorepo changes** (official repository `ken-jo/agent-marketplace`,
`6a4d3b3df`; five `plugin` packages and `templates/plugin` at that commit):

1. With the Lease republish wave (amendment §9.5 step 4): README and `description`
   wording, `templates/plugin` → `templates/extension`, the index generator writes the
   format-2 file; the vendored checker is rebuilt from the 0.12.0 tag. Whether the
   `agent-plugin` schema and the `components` extraction in `tools/repo.mjs` are in
   that rebuild is decided by the two timelines below.
2. After slice C: one official `agent-plugin` package as the launch example (owner
   decision 5) — a meeting-notes kit made of one skill, one template prompt and one
   routine template, with no MCP server and no hook, so the first thing a user installs
   from the new tab executes no code and creates no routine. Its `minAppVersion` is the
   release that ships slice C.
3. the portal and repository plugins: README wording only under this design, at the republish the
   amendment already requires of them.

**Order relative to releases.** Slice A now. Slice B merges to `main` after the v0.11.0
tag and ships in 0.12.0 with the Lease (owner decision 1), so the republish wave and the
new word arrive together. Slices D and E ship in 0.13.0. Slice C merges after the
amendment's slice C, and its release is one of exactly two timelines, chosen by whether
it is on `main` when the amendment's E1 release PR is cut:

- **Timeline 1 — C is in the 0.12.0 tag.** The 0.12.0 vendored checker (rebuilt from
  that tag, amendment §9.5 step 3) knows the kind; the wave's generator update carries
  the `agent-plugin` schema and the `components` extractor; the example package (item 2)
  may be published in the wave with `minAppVersion` 0.12.0; no 0.12.0 app lacks the
  kind.
- **Timeline 2 — C is not in the 0.12.0 tag.** The 0.12.0 wave finishes exactly as the
  amendment specifies, with a format-2 checker and generator that do not know the kind;
  nothing in the wave waits for this design. C ships in 0.13.0; after the 0.13.0 tag a
  **second** checker rebuild and generator update add the kind, the schema and the
  extractor, and the example package is published then with `minAppVersion` 0.13.0.
  Until that release, a 0.12.0 app drops any `agent-plugin` entry per entry (§5.2),
  which is the cost of this timeline and is stated as such.

Neither timeline moves v0.11.0, the 0.12.0 tag or the amendment's gates; no step of the
wave depends on a tag that does not yet exist.

---

## 8. Owner decisions (closed 2026-09-27)

Every product choice this page raised has been decided by the owner. None remains open.

| # | Decision | Owner's ruling | Where it is applied |
|---|---|---|---|
| 1 | Which release carries the vocabulary change (slice B) | **0.12.0**, together with the Lease republish wave | §7 order; §6.3, §6.4 |
| 2 | The Korean word for "extension" | **익스텐션** everywhere; 플러그인 for plugin; 확장 is not used | §0, §1.4, §6.1, slice B |
| 3 | Whether the app ever commits or pushes to a git marketplace | **Never.** Sharing is a file export or a write into a local marketplace checkout; publishing is a pull request | §4.5, decision 15 |
| 4 | How plugins relate to routines | **A plugin ships no routine that runs.** It ships routine templates and, typically, a skill that helps the user create a routine. The routine is created through the existing routine-creation flow with its approvals, is owned by the user, survives plugin removal, and the plugin cannot enable, update or revoke it | §1.5, §2.2, §3.4, §4.1, §5.3, §5.5, decision 10 |
| 5 | Whether an official example plugin ships with slice C | **Yes, one**, executing no code | §7 monorepo item 2 |

---

## 9. Decisions

| # | Decision | Reason |
|---|---|---|
| 1 | Extension ⇔ `extensions["ai.agent-connector.ave"]` has `entry` or `process`; a plugin has neither; the schema's three-branch `oneOf` (entry, process, plugin) makes a package never both, and a malformed marker refuses the package rather than downgrading it (§1.3, §2.1) | The marker already exists and is required (`schema:122-125`); two lifecycles cannot share a package; an extension already carries every component a plugin can; the tree is checked by kind after classification because a schema cannot see it |
| 2 | Trust attaches to components and capabilities, never to the label (§1.5) | An MCP server or a hook is code wherever it is declared; the controls they need exist and are reused, with the confinement §3.3 adds |
| 3 | Plugins conform to Agent Plugins 1.0.0 with Ave components under the `ai.agent-connector.ave` manifest key and directory, discovered at fixed locations without declarations; root `required` is `$schema` + `name`, with `version`/`description` required by the marketplace (§2.1) | The manifest already is such a document; fixed locations are the specification's own design; the official schema requires only two fields and a portable package must parse |
| 4 | `mcp.json` is the official `mcp.schema.json` shape (`$schema`, `type: "stdio" \| "streamable-http"`, bare or `./`-relative `command`, no placeholder in `command`, validated `cwd`), parsed by a portable parser, projected onto the host's `transport` spec, and exported by the inverse (§2.1 item 5) | The host's spec is a different vocabulary; relabelling would make exports non-portable and reject standard packages; the two words stay distinct |
| 5 | Launch components: skills, MCP servers, prompts (template and persona), agent profiles, routine templates; hooks one slice later; everything else ignored with a diagnostic, and the listed ones rejected by name (§2.2) | Each supported component maps onto a store or path the host already has; hooks need confinement work and their own slice; the rejected ones would each add a surface |
| 6 | Commands become template prompts through the MCP-prompt surface; hooks map onto the closed Ave event set in argv form only; unmappable events and handler types are rejected by name; the stdin and decision protocol is not translated and imported hooks carry `needsAdaptation` until the user clears it (§2.3) | The slash picker already carries author-written prompts with non-keyboard provenance; the hook runner spawns argv and nothing else; emulating another host's protocol would be a second protocol |
| 7 | Import and export are studio operations that produce a reviewed draft, never part of install; portable files win over legacy projections; `$schema` is always synthesized; declared component paths and inline definitions are read; missing `version`/`description` block validation until the user supplies them (§2.4) | The transformation drops and rewrites fields; the user must see the result before it runs; a re-import of an export must not read anything twice |
| 8 | A plugin's MCP servers go through the extension-bundled projection: fingerprint approval that never transfers, scoped preparation and atomic publication, governance at connect, ASRT wrap when the sandbox is on, `low` tier (§3.2) | The path exists, is tested, and is the same one hand-added and extension-bundled servers use; no new path means no new back door |
| 9 | One `admitted` predicate over approval provenance — managed, or policy-fingerprint still listed in `bundledServers`, or user with `allowUserApprovedServers` true — governs lookup, every insertion, reuse, publication (rechecked against the current policy) and reload cleanup; refused preparations spawn nothing; a policy change disconnects exactly the approvals that stopped being admitted (§3.2) | The named-setter design missed the manager's real path, and an exemption at insertion cannot rescue an approval the lookup refuses; one predicate in one place is the only way the five paths cannot disagree; bundled ids are generation-bound and cannot be listed as managed servers |
| 10 | A plugin ships routine templates only; a routine is created by the user through the panel's add form or the approval-gated `routine_schedule` tool, is user-owned, carries the template as attribution, and is untouched by plugin disable, update, uninstall or revocation (§3.4; owner decision 4) | Installation is never consent to an unattended turn; no package-bound execution exists, so there is nothing package-scoped to abort; the user's routine controls are the only controls |
| 11 | Template prompts get their own `ChatInputOrigin` value; package personas and skills use package-qualified ids and selectors (`agent-plugin:<package>:<name>`), the bare name space stays the user's, and the `user-keyboard` persona guard is untouched (§3.5) | Attribution must say who wrote the text; a package must never shadow a local identity or another package's; the guard is a security boundary, not an inconvenience |
| 12 | The studio composes from installed skills, routines (as templates), connectors, prompts and profiles plus model-authored text; it never composes code, hooks or scripts (§4.1) | No-code means no code; the studio says so instead of degrading |
| 13 | Conversation-driven creation uses three approval-gated builtin tools that write only under `~/.ave/studio/` and cannot install, share or read secrets (§4.2) | The assistant may draft; only the user installs |
| 14 | A draft installs as a source-less package through the content path; provenance travels as author-declared `provenance.json` and file metadata, labelled as such by the installer, whose review stays authoritative (§4.3) | The `origin: null` shape exists for pasted servers; provenance must travel with the package, and a self-declaration must not read as verification |
| 15 | Sharing is export-a-file or write-into-a-marketplace-checkout; the app never commits or pushes (§4.5; owner decision 3) | The git contract is read-only; a merge is the publish |
| 16 | Author review is bound to the tree digest and cleared by any write; installer review of full texts before installing; an advisory injection lint that is explicitly not a security control (§4.6) | A review of bytes that later changed is not a review; the permission system is the control; a heuristic must not be sold as a gate |
| 17 | New kind literal `agent-plugin`; the `plugin` literal keeps its value; kind tab order puts Plugins first from slice C (§5.1) | The literal names the specification; the old literal is persisted everywhere; ordinary users come first; the union member must exist before the order names it |
| 18 | The descriptor's `components` summary is a **static authority** derived from package content only — symbolic paths and placeholders, component names, per-file hashes — with a content digest per component and the execution-relevant fields (routine prompt and schedule, hook matcher and timeout, MCP `cwd`); it excludes every runtime value (absolute paths, generation and activation ids, server ids, secrets); update review diffs by digest; a changed MCP server or hook is unapproved until re-approved (§5.2) | The catalog must show what executes before any byte is fetched, and a human must be able to see which text changed; an inventory is not an authority; a digest that includes an installation path differs on every machine and would reject an unchanged install |
| 19 | The new kind is listed only in the format-2 index and `schemaVersion: 2` descriptors; what each app actually sees is stated, including the per-entry drop on an app whose schema lacks the kind and the path-claim case the checker must prevent (the original three-cohort split is historical since 2026-10-14); slice C reorders the validator's path claim (§5.2) | The older-app trap is a renamed literal or a widened closed object; a compatibility claim must say what the old reader does, not what it never sees |
| 20 | Delivery is the tree export with a tree digest; no artifact ladder (§5.2) | Nothing is compiled; skills already ship this way |
| 21 | Identifiers are not renamed: IDs, tool names, channels, `plugin.json`, the namespace key, receipts, the `plugin` kind literal, i18n keys, code names (§6.2); the proposal's separate extension-manifest filename is rejected | Each is persisted, vendored, hash-pinned or locked; the collision the proposal feared is solved by the namespace the manifest already uses |
| 22 | Existing packages become extensions by classification at load and in the catalog from slice B; no migration file, no reinstall; the installed-manifest retired-field strip is preserved; the amendment's protocol-2 cutoff is not softened or restated (§6.3) | Classification is derived from `entry`; nothing on disk changes meaning; the cutoff belongs to the amendment |
| 23 | No dependency on the Lease wave in either direction; the wave carries the README, template and generator changes, and the kind's schema only in timeline 1 (§6.4, §7) | Extensions are extensions under any protocol version; the wave is the cheapest moment to change wording; no wave step may wait for a tag that does not exist |
| 24 | Five slices with the gates and lock suites of §7; B in 0.12.0 (owner decision 1); C after the amendment's slice C on one of two stated timelines; D and E in 0.13.0; nothing in v0.11.0; the full validation run happens once, on the merged tree before merge | Owner constraint; each slice is coherent at its own boundary; the format-2 reader is written once; the hook owns the full run |
| 25 | A bundled server's credential is stored in the encrypted secret document store under a stable installed-package key, resolved into the in-memory connect config at preparation, entered through `setBundledApiKey`, kept across updates that keep the declaration, and never routed through `setApiKey`/`saveConfigs` (§3.2) | The existing setter persists plain JSON and needs a persisted config entry; a bundled server has neither, and its runtime id is generation-bound |
| 26 | Bundled hooks (plugin and extension) run under the MCP stdio confinement class: ASRT-wrapped with a `PLUGIN_DATA`-only write grant and the deny-list read model when the sandbox is on, fail-closed (every blocking event denied, observe-only events pass), plain spawn stated as unconfined when it is off, refused on Windows with the sandbox on; the wrap is one shared helper; the invocation is built by the placeholder-aware adapter `resolveBundledArgv` — classify tokens, anchor package paths only (`./` kept, `anchorIndexes`), expand validated data references afterwards, refuse bare path literals — shared with the portable MCP runtime resolution under a separate executable policy in which the launcher grammar marks pinned package and image tokens as literals (§3.3) | The runner has no sandbox branch today and anchoring a path does not confine a program; the anchoring helper examines every path-like token, so a whole-argv pass either rejects data arguments or admits absolute ones; a consent sheet must describe what holds; the two spawn sites must not drift |
| 27 | `cwd` is a projected, validated, descriptor-carried field honoured by both spawn paths; `PLUGIN_DATA` is `~/.ave/agent-plugin-data/<name>/`, keyed by package name, and is the one directory added to the wrapped write grant (§2.1 item 7, §3.2) | Two environment variables do not make a directory writable or a relative path resolvable; the grant must be narrow and the identity stable across updates |

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
   a hook run code. The label cannot stand in for the review.
8. **Push to a git marketplace from the app.** Write credentials, branch protection and
   an unrecoverable wrong push, for a step a pull request does better. Rejected by the
   owner (decision 3).
9. **Make the injection lint a gate.** A phrase-matching gate is bypassed by rephrasing
   and would be presented as protection it does not give.
10. **A separate extension manifest file** (the 2026-08-16 proposal).
    The namespace the manifest already uses is the specification's answer to that
    collision.
11. **Plugin-owned routines: install disabled, switch on per template, dismiss and abort
    on plugin removal** (the first revision of this page). Rejected by the owner
    (decision 4): a routine bound to a package needs a package-scoped abort path on
    disable, uninstall and revocation, a rule for what a package update does to a
    running routine, and a second owner for a record the user can also edit. User-owned
    routines created from templates have none of those questions, and the user's
    existing routine controls are complete.
12. **Relabel the portable `type: "streamable-http"` as the host's `http` and accept
    `${PLUGIN_ROOT}/<path>` as `command`** (the first revision). Both make the file
    non-portable and reject standard packages; the specification's grammar for
    `command` and its own `$schema` for `mcp.json` are the format.
13. **Unrestricted plugin hooks with anchoring as the only control** (the first
    revision's implied behaviour). Anchoring bounds where the program lives, not what it
    does; the consent sheet would have described a confinement that did not exist.
14. **Store a bundled server's credential through the existing `setApiKey`.** It writes
    the whole config list as plain JSON and needs a persisted entry with a stable id;
    neither holds for a bundled server.
15. **Hash the runtime projection into the descriptor's `components`** (the second
    revision). The runtime projection anchors argv to absolute sealed paths and mints
    generation- and activation-bound ids, so identical package bytes hash differently on
    every machine and an unchanged install fails `MANIFEST_MISMATCH`; the authority is
    the static form (§5.2), and the runtime form is derived from it.
16. **Exempt policy-approved bundled servers from the organization switch at insertion
    while the lookup hides every runtime approval** (the second revision). An approval
    the lookup refuses cannot connect whatever the insertion allowed; admission is one
    predicate over provenance (§3.2).

---

## 11. Sources

External documentation consulted for this page, all accessed 2026-09-27 (KST):

1. Agent Plugins Specification v1.0.0 (Status: Published) —
   https://agent-plugins.org/specification, with its schemas
   https://agent-plugins.org/schemas/1.0.0/plugin.schema.json (required: `$schema`,
   `name`) and https://agent-plugins.org/schemas/1.0.0/mcp.schema.json (`$schema`,
   `mcpServers`; `type: "stdio" | "streamable-http"`), and the author page
   https://agent-plugins.org/plugin-authors/mcp-servers (`command` is one executable
   token, bare or `./`-relative, no placeholder expansion; `cwd` defaults to the plugin
   root and must stay within `${PLUGIN_ROOT}` or `${PLUGIN_DATA}`). Used: §4.2 standard
   layout; §5.1–5.2 manifest location and the closed ten-key object, report-and-ignore
   for unknown top-level fields; §6 fixed component locations; §7.1 skills (`skills/`,
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
   (§2.4): `.claude-plugin/plugin.json` with `name` the only required field and
   `version`/`description` optional; default component locations (`skills/`,
   `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`,
   `output-styles/`, `workflows/`, `themes/`, `monitors/`, `bin/`, `settings.json`) and
   the manifest fields that override them with custom paths or inline definitions; the
   `commands` map fields (`description`, `argumentHint`, `model`, `allowedTools`);
   `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`;
   `${user_config.*}`.
4. Claude Code marketplaces and hooks — https://code.claude.com/docs/en/plugin-marketplaces
   (`.claude-plugin/marketplace.json`, entry `source` forms, reserved names) and
   https://code.claude.com/docs/en/hooks (hook events and the handler types `command`,
   `http`, `mcp_tool`, `prompt`, `agent`; exec and shell forms; the stdin and decision
   protocol §2.3 does not translate). Used for §2.3.
5. Codex plugins — https://developers.openai.com/codex/plugins and
   https://developers.openai.com/codex/plugins/build. Used for §2.4: root `plugin.json`
   with the Agent Plugins schema, `skills/`, `mcp.json`, `extensions.com.openai`,
   `.codex-plugin/plugin.json` as a compatibility fallback, a `hooks/` directory,
   marketplace files at `.agents/plugins/marketplace.json` and
   `~/.agents/plugins/marketplace.json`, the legacy-compatible
   `.claude-plugin/marketplace.json`; the packaging page's statement that renaming a
   legacy `.mcp.json` is not a conversion because the portable format declares a
   transport `type`.
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
8. Codex automations (scheduled tasks) — https://developers.openai.com/codex/automations.
   Used for §3.4: scheduled tasks are created and updated by the user from a chat;
   skills can create or update scheduled tasks; a task can use plugins. The task is the
   user's; the plugin that helped create it does not own it.

---

## Unverified in this document

- Process-entry extension runtime support remains pending a protocol slice; this app classifies those manifests as extensions and refuses activation until that runtime exists.
- The file format of the `hooks/` directory in the layout of source 5 (the page names
  the directory and a `hooks/hooks.json` file; the file's shape was not read). The
  importer therefore does not read it; if it is the `hooks.json` shape of §2.3, a later
  change can map it with the same table and the same `needsAdaptation` rule.

Everything else this page states about current code was read at `f1a8d191e` (or at
amendment commit `e0f687db8`) and is cited by line.
