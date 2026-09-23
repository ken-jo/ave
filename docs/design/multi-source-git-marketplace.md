# Multi-source Git Marketplace — Design Specification

> Status: **Proposal — accepted direction, not implemented** (2026-09-23).
> Architecture: [../architecture/proposals/multi-source-git-marketplace.md](../architecture/proposals/multi-source-git-marketplace.md) ·
> Blueprint: [../blueprints/multi-source-git-marketplace.md](../blueprints/multi-source-git-marketplace.md) ·
> Mockup: [multi-source-git-marketplace.html](./multi-source-git-marketplace.html) ·
> Korean mirror: [../ko/design/multi-source-git-marketplace.md](../ko/design/multi-source-git-marketplace.md)
>
> This page owns the contracts: file formats, algorithms, IPC, error codes and
> UI states. When code lands, the code and its tests become authoritative and
> this page is updated in the same change.

## 1. Glossary

| Term | Meaning |
|---|---|
| **Source** | A registered git repository the app reads packages from. Origins: `official` (hard-coded in the app), `managed` (registered by the system policy file), `custom` (added by the user), `direct` (one package, no marketplace). |
| **Marketplace repository** | A source whose root has `marketplace.json`, or that follows the conventional layout (§3.3). |
| **Package** | One installable unit: `plugin`, `mcp`, `skill`, `agent`, `theme`, `font`, `language`, `provider`, `messaging-connection`. |
| **Descriptor** | `ave-package.json` in a package directory: kind, name, version, minimum app version, declared authority, payload. |
| **Pin** | The commit SHA a source is currently read at. |
| **Snapshot** | The parsed, validated catalog of one source at one pin. Immutable. |
| **Install plan** | What the resolver will do for one package version, bound to one snapshot commit: artifact rungs, files, launcher, required consent. |
| **Rung** | One step of the plugin artifact ladder: `release`, `archive`, `tree`. |

## 2. Client state on disk

```
~/.ave/
  installation-id                     # random UUID, local only (rollout bucketing)
  marketplaces/
    sources.json                      # custom and direct sources (§2.1)
    <sourceId>/
      repo.git/                       # bare partial clone (blob:none)
      snapshots/<commit>.json         # validated snapshots (§2.2)
      state.json                      # pin, enabled, last sync outcome (§2.1)
  packages/
    <kind>/<name>/<version>/          # installed content packages
    ledger.json                       # installed content packages + origin
    default-installs.json             # default-install keys already applied on this machine (§10.2)
  plugins/                            # unchanged plugin install root
  runtime/git/<version>/              # managed git copy (§9)
```

`installation-id` carries no authority. A file that is not a UUID is replaced
with a new one, and the installation falls into fresh rollout buckets exactly
as a new installation would.

### 2.1 Source records

```ts
interface SourcesFile {
  version: 1;
  sources: SourceEntry[];             // custom and direct only
}

interface SourceEntry {
  id: string;                 // ^[a-z0-9][a-z0-9-]{1,62}$, reserved names rejected (§5.1)
  origin: "custom" | "direct";
  url: string;                // stored in normalized form (§7.1); http only for policy-listed hosts
  ref?: string;               // branch or tag; default = remote HEAD
  subdir?: string;            // direct sources only: package path inside the repo
  auth: { kind: "none" } | { kind: "token"; host: string } | { kind: "ssh" };
  addedAt: string;            // ISO-8601
  label?: string;             // user-visible override of displayName
}

interface SourceState {       // marketplaces/<id>/state.json, every origin
  pinnedCommit: string | null;   // 40-hex; null until the first successful sync
  enabled: boolean;              // browsing and installing only (§7.3)
  lastSync?: { at: string; result: "ok" | ErrorCode; candidate?: string };
  pendingRewrite?: { candidate: string; seenAt: string };   // custom/direct awaiting review
}
```

- The official source comes from the build constant `OFFICIAL_MARKETPLACE`
  (`id: "ave"`, primary URL, optional mirror URLs, `auth`). Managed sources
  come from the system policy file (§12). Neither is stored in `sources.json`;
  both keep their state in `state.json`.
- While the design is built, the official repository is private
  (`https://github.com/ken-jo/ave-marketplace-index`, decided 2026-09-23
  because the `former_org` organization cannot host a new public repository
  or run CI). The constant therefore carries
  `auth: { kind: "token", host: "github.com" }` and the Sources view offers
  Set token on the official row; an OS credential helper answers as well
  (§9.3). Before the first public release built on this design, the
  repository becomes publicly readable or moves, and that release's constant
  carries the public URL with `auth: { kind: "none" }`. No released build
  carries the private URL, so no `movedTo`-style migration is needed.
- Tokens live in the existing encrypted secret store under
  `marketplace.gitToken.<normalized host>`; no file above holds a secret.
- `snapshots/` keeps the current pin, the previous pin, and every commit that
  an installed package's `origin.commit` still references; older files are
  pruned after each successful sync.
- A `sources.json` entry that no longer passes the id and URL checks — a
  reserved id, an id a managed source now uses, a URL not in normalized form —
  stays in the file untouched but is not served; the Sources view lists it as
  a diagnostic. It still holds its id: adding a source under that id is
  refused, and removing a served source with the same id removes only the
  served entry. A `sources.json` that cannot be read serves the official and
  managed sources only and refuses writes until it is repaired, so nothing the
  user added is overwritten.
- A `state.json` that cannot be read fails that source's sync with the file
  named. It is never treated as a fresh, unpinned source: a first sync accepts
  any history. A missing `state.json` next to a `repo.git` or `snapshots/` is
  the same failure; a sync writes the state before it creates the repository,
  so only a lost file looks like that.

### 2.2 Snapshot

```ts
interface SourceSnapshot {
  sourceId: string;
  commit: string;
  fetchedAt: string;
  marketplace: { name: string; displayName: string; description?: string; owner?: { name: string; url?: string } };
  packages: CatalogPackage[];          // §4, after validation and normalization
  revocations: Revocation[];           // this source's own policy/revocations.json (§10.4)
  diagnostics: SnapshotDiagnostic[];   // per-package rejections, shown in the Sources view
}
```

A package that fails validation is dropped from the snapshot with a
diagnostic; the rest of the source stays usable. An invalid `marketplace.json`
(unparseable, wrong `schemaVersion`, duplicate keys) rejects the whole
candidate commit and keeps the previous pin. So does an invalid
`policy/revocations.json`: accepting the rest of that commit would silently
drop a revocation. Both files are read under the size limits of §5.4.

### 2.3 Registry origin

`PluginRegistryEntry` gains:

```ts
origin?: {
  sourceId: string;
  sourceOrigin: "official" | "managed" | "custom" | "direct";
  commit: string;
  packagePath: string;
  version: string;
  rung: "release" | "archive" | "tree" | "legacy";   // "legacy": bound by the §16.3 migration, no digest yet
  artifactSha256: string | null;   // zip sha256 (release/archive), tree digest (§6.4), null for legacy
  installedAt: string;
};
```

`installSource` becomes `user | local-dev`; the `admin` value is removed with
the managed-install mechanism (§10.1, §16.3). Content packages record the same
origin in `packages/ledger.json`.

- `commit` is the snapshot commit the install plan was bound to, so the
  snapshot pruning of §2.1 keeps it.
- Only a git install writes `origin`. Every other path that replaces the
  files — a catalog install while it still exists, a local build, a
  rollback — removes it, because it would otherwise claim a provenance for
  bytes it did not install.
- A git install writes install receipt schema v4: `installSource: "git"`, no
  signer and no admission, `artifactSha256` as above, and a `git` record with
  the source, the snapshot and version commits, the package path, the used
  rung and every rung outcome in ladder order. Signed and local installs keep
  writing v3 unchanged.

## 3. Marketplace repository layout

### 3.1 Official monorepo

```
marketplace.json                 # index (generated by CI, committed)
plugins/<name>/ave-package.json # release/archive pins; optional built tree (plugin.json, dist/)
mcp/<name>/ave-package.json     # + optional server.json
skills/<name>/                   # ave-package.json, SKILL.md, resources
agents/<name>/                   # ave-package.json, AGENTS.md
themes/<name>/                   # ave-package.json, theme.json
fonts/<name>/                    # ave-package.json, font.json, files/
languages/<locale>/              # ave-package.json, language.json, messages.json
providers/<name>/                # ave-package.json, provider.json
messaging/<name>/                # ave-package.json, connection.json
policy/revocations.json          # revocations of this repository's own packages
.github/CODEOWNERS
.github/workflows/               # validate, index, release-pin
```

### 3.2 Custom marketplace

Same layout, including the optional `policy/revocations.json`, which only ever
applies to packages installed from that same source (§10.4).
`marketplace.json` may be hand-written and may list only `path` for each
package (§4.2).

### 3.3 Conventional layout without `marketplace.json`

If the root has no `marketplace.json`, the client scans these directories at
the pinned commit, one level deep, for `ave-package.json`:
`plugins/ mcp/ skills/ agents/ themes/ fonts/ languages/ providers/ messaging/`.
A descriptor must declare the kind of the directory it sits
in (`plugins/` → `plugin`, …); one that does not is dropped with a
diagnostic. The marketplace name defaults to the source id. A repository with neither an
index nor any descriptor in those directories is not a marketplace; the add
dialog offers the direct-install flow instead.

## 4. `marketplace.json` (index)

### 4.1 Schema

```ts
interface MarketplaceIndex {
  $schema?: string;
  schemaVersion: 1;
  name: string;                     // must equal the source id for official; informative otherwise
  displayName: string;
  description?: string;
  owner?: { name: string; url?: string };
  packages: IndexPackage[];
}

interface IndexPackage {
  kind: PackageKind;
  name: string;                     // unique per kind within this index
  path: string;                     // repo-relative, no "./" prefix, no "..", "/" separators
  displayName?: string;
  description?: string;
  keywords?: string[];
  icon?: string;                    // repo-relative .png/.jpg/.webp, ≤ 256 KB, served from the git tree only
  latest?: string;                  // semver; must be in versions[] and not yanked
  versions?: IndexVersion[];        // newest first; absent = read the descriptor at the pin
}

interface IndexVersion {
  version: string;                  // semver 2.0.0
  commit: string;                   // 40-hex; the commit whose descriptor declares this version
  minAppVersion: string;            // copy of the descriptor's value
  platforms?: Array<"darwin" | "win32" | "linux">;   // copy of the descriptor's value
  authority?: PluginAuthority;      // plugin kind: copy of the descriptor's authority (§5.2)
  artifact?: PluginArtifactPins;    // plugin kind only (§5.2)
  rollout?: { percent: number };    // 1..100; absent = 100
  yanked?: { reason: string; at: string };
  publishedAt: string;
}
```

### 4.2 Rules

- `(kind, name)` is unique and `path` is unique; when two entries claim the
  same pair or the same path, every claimant is dropped with a diagnostic,
  because the client cannot tell which one the author meant. An entry that
  fails validation still counts as a claimant.
  `(kind, name, version)` maps to exactly one commit. CI rejects re-publishing an existing version at a new commit.
- Versions strictly increase per package (the existing plugin rule, now for
  every kind). `latest` never names a yanked version.
- When `versions` is absent, the client reads `ave-package.json` at `path`
  at the pinned commit and treats it as the single available version.
- Unknown root keys are rejected in `schemaVersion: 1`.

### 4.3 Official index generation

CI regenerates `marketplace.json` from the previous index plus the descriptors
at the merge commit and fails the PR if the committed file differs. A merge to
`main` is the publish (D8). The release-pin workflow (§6.3) is the only
automation that edits artifact pins.

## 5. Package descriptor `ave-package.json`

### 5.1 Common fields and naming

```ts
interface PackageDescriptor {
  $schema?: string;
  schemaVersion: 1;
  kind: PackageKind;
  name: string;                     // plugin: equals plugin.json `name`
  version: string;                  // required, semver
  minAppVersion: string;            // required, plain MAJOR.MINOR.PATCH
  displayName?: string;
  description?: string;
  author?: { name: string; url?: string; email?: string };
  license?: string;                 // SPDX
  homepage?: string;
  icon?: string;
  platforms?: Array<"darwin" | "win32" | "linux">;
  payload: KindPayload;             // §5.2
}
```

- Compatibility uses the host's existing `minAppVersion` contract and its
  comparison, `appVersionSatisfiesMin` (`src/shared/semver-compare.ts`): a
  package installs and runs when `appVersion >= minAppVersion`, and the check
  fails closed when either value is unparseable. No second compatibility
  vocabulary is introduced.
- Source ids: `ave`, `official`, `ave-official` and every `ave-*` id are
  reserved. The check re-runs on every load.
- A descriptor's `icon` is relative to its package directory; the snapshot
  stores it repository-relative, like the index's `icon`.

### 5.2 Payload by kind

| Kind | Payload | Files the package directory may contain |
|---|---|---|
| `plugin` | `{ authority: PluginAuthority; artifact: PluginArtifactPins }` | `ave-package.json`; for the tree rung also `plugin.json`, `dist/**`, `assets/**` |
| `mcp` | `{ server: McpServerSpec } \| { serverJson: "server.json", select?: { package?: number; remote?: number } }` | `ave-package.json`, `server.json`, optional `server/**` for a package-local stdio command |
| `skill` | `{ entry: "SKILL.md" }` | `SKILL.md`, `references/**`, `assets/**` |
| `agent` | `{ entry: "AGENTS.md" }` | `AGENTS.md` |
| `theme` | `{ entry: "theme.json" }` | `theme.json`, optional preview image |
| `font` | `{ entry: "font.json" }` | `font.json`, `files/*.woff2\|woff\|ttf\|otf`, `LICENSE` |
| `language` | `{ locale: string; entry: "language.json"; messages: "messages.json" }` | those two JSON files |
| `provider` | `{ entry: "provider.json" }` | `provider.json` (today's `MarketplaceProviderPackageAsset` minus `type`) |
| `messaging-connection` | `{ entry: "connection.json" }` | `connection.json` (today's messaging asset minus `type`) |

```ts
// Copied verbatim from the plugin's plugin.json (extensions["ai.agent-connector.ave"]).
// The catalog reads it without downloading bytes; install compares it with
// the staged plugin.json (§6.2). It is the trusted "expected" side that
// today's catalog row provides to assertInstalledManifestMatchesCatalog.
// Every field is the manifest's own subschema: the index and descriptor
// schemas reference plugin.schema.json instead of restating it.
interface PluginAuthority {
  capabilities: string[];
  networkAccess?: unknown;          // same shape as the manifest field
  hostSecrets?: { read: string[] };
  pluginAccess?: unknown;
  auth?: unknown;
  requires: { capabilities?: string[]; minAppVersion: string };   // required (§5.3)
  dependencies?: unknown[];         // same shape as the manifest field
}

interface PluginArtifactPins {
  release?: {
    repo?: string;      // "owner/name" on the same host as the source; required in marketplace repositories unless url is set
    tag?: string;       // default "v{version}"
    asset?: string;     // default "{name}-{version}.zip"
    url?: string;       // explicit https URL for non-GitHub release hosts; exclusive with repo, tag and asset
    sha256?: string;    // the pin stored in git; without it the rung is skipped (ARTIFACT_NOT_PINNED)
  };
  archive?: { url: string; sha256?: string };
  tree?: string;        // repo-relative directory holding plugin.json + dist/; default = package path
}

// The host's MCP runtime spec (src/plugins/mcp-runtime-spec.ts) without the
// fields a package may not decide for itself (private-network access, OAuth
// client metadata).
type McpServerSpec =
  | { transport: "stdio"; command: "npx" | "uvx" | "docker" | string; args?: string[];
      env?: Record<string, string>; auth?: "none" | "api-key" | "sso"; apiKeyEnv?: string }
  | { transport: "http"; url: string; auth?: "none" | "api-key" | "sso" | "oauth"; apiKeyHeader?: string };
```

- `release.repo` may be omitted only for a **direct** source, where it
  defaults to the source repository itself.
- A `stdio` command that is not `npx`, `uvx` or `docker` must be a path
  relative to the package directory (`server/…`); absolute paths, `..`, `\`,
  `:` and control characters are rejected, so no platform reads it as another
  separator or a drive.
- `env` names, `apiKeyEnv` and `apiKeyHeader` may not use a name the host
  reserves (`src/mcp/safe-names.ts`), nor a variable a launcher reads to
  choose where code comes from or how it is trusted: `npm_config_*`,
  `PNPM_*`, `YARN_*`, `BUN_*`, `COREPACK_*`, `UV_*`, `PIP_*`, `DOCKER_*`,
  `NODE_*`, `PYTHON*` (except `PYTHONUNBUFFERED`, `PYTHONIOENCODING`,
  `PYTHONUTF8`), the dynamic loader's `DYLD_*` and `LD_*`, `XDG_CONFIG_HOME`,
  the `*_PROXY` variables and the CA bundle variables, in any case.
- The launched MCP code is fixed by the commit. Both the descriptor's own
  spec and a spec built from `server.json` must follow this grammar, so no
  option can pick another registry or index, add a package, or widen the
  container:

  ```
  npx    [-y | --yes]… <package>@<exact version> [server args…]
  uvx    <package>[extras]==<exact version> [server args…]
  uvx    --from <package>[extras]==<exact version> <command> [server args…]
  docker run [-i | -t | --rm | --init | -e NAME[=value] | --network none|bridge]… <image> [server args…]
  ```

  An npm package is a registry name (never a URL, path or git spec); a PyPI
  version has no wildcard; a docker image carries a tag other than `latest`
  or a `@sha256:` digest. Everything after the package or image belongs to
  the server. A descriptor's own docker image may name any registry, since
  the approval step shows the full image reference.
- `server.json` (schema 2025-12-11) maps to the spec as follows: npm →
  `npx -y <identifier>@<version> [packageArguments]`; pypi →
  `uvx <identifier>==<version> [packageArguments]`; oci →
  `docker run -i --rm [runtimeArguments] <identifier>[:<version>]
  [packageArguments]`; a `streamable-http` remote → `http`. Arguments and
  variables take `value`, else `default`; a named argument becomes
  `name value`. One `isSecret` variable or header becomes `apiKeyEnv` or
  `apiKeyHeader` with `auth: "api-key"`. Refused: `sse`, other registries or
  a non-default `registryBaseUrl`, an oci identifier on a registry host other
  than Docker Hub, `runtimeArguments` for npm and pypi (npx and uvx options
  choose registries and extra packages), oci `runtimeArguments` outside the
  docker grammar above or that would put another image first, a package
  whose transport is not stdio, `{variable}` templates and `variables`, a
  required input without a value, remote headers with fixed values, and more
  than one secret. `select` picks one package or one remote; without it the
  first package is used, else the first remote.
- A package-local command runs from the package's `server/` directory
  exported at the version's commit, which must contain the command; the MCP
  artifact store installs those files and `$PLUGIN_DIR` points at them.
  `$PLUGIN_DIR` without package files, and `$PYTHON`, are refused.

### 5.3 Plugin manifest changes

For a plugin installed from any git source:

- `extensions["ai.agent-connector.ave"].requires.minAppVersion` is **required** (the
  schema keeps it optional for local development installs) and must equal the
  descriptor's `minAppVersion`.
- Every field of `PluginAuthority` must equal the staged `plugin.json`.

Removed from the manifest schema, the SDK copy, `manifest-validation.ts` and
their tests in one change (blueprint phase 6):

- `extensions["ai.agent-connector.ave"].installPolicy` — there are no managed packages
  (§10.1). The install plan (staging and the index CI) rejects a manifest that
  still carries the field, with a message naming it. The runtime loader does
  not: every official plugin installed today carries the field, so an
  installed manifest that has it loads as before, the field is ignored and one
  warning per plugin is logged, until the next update replaces the manifest
  (§16.3). The official plugin repositories drop the field in their first
  release under this design (blueprint phase 0.5); a field-pin version
  (§16.3) keeps it, because it serves existing installs only, and an install
  that resolves to such a version fails with the same named rejection.
- `extensions["ai.agent-connector.ave"].publisher` — under D4 there is no verified
  publishing identity for it to name.

### 5.4 Content validation limits

| Kind | Max total | Max files | Allowed extensions |
|---|---|---|---|
| skill | 2 MB | 64 | `.md .txt .json .yaml .yml .png .jpg .webp` |
| agent | 256 KB | 1 | `.md` |
| theme | 256 KB | 4 | `.json .png .jpg .webp` |
| font | 20 MB | 32 | `.json .woff2 .woff .ttf .otf` + `LICENSE` |
| language | 4 MB | 2 | `.json` |
| provider, messaging-connection | 64 KB | 1 | `.json` |
| plugin (any rung) | existing `marketplace-artifact-limits.ts` | | |

The marketplace files themselves are capped too: `marketplace.json` 16 MB,
`ave-package.json` 256 KB, `policy/revocations.json` 1 MB. A larger
descriptor drops its package with a diagnostic; a larger index or revocations
file rejects the commit. Git cannot learn a blob's size before transferring
it, so the limits are checked once the object is local; the transfer itself
is bounded by the fetch timeout (§9.3).

SVG is excluded from content kinds: it is an active document when rendered
inline. Links, devices and paths that escape the package directory are
rejected (reusing `sideload-filter.ts` and `zip-entry-path.ts`). Images and
fonts reach the renderer only through a host asset scheme, never by file
path.

### 5.5 Installed content in the app

Content packages install under `packages/<kind>/<name>/<version>/` and are
recorded in `packages/ledger.json`. A ledger entry is `{ kind, name,
version, origin }`, and its origin is `{ sourceId, sourceOrigin, commit,
packagePath, version, contentSha256, installedAt }`: content has no rungs,
so `contentSha256` is the tree digest (§6.4) of the installed files. The
ledger feeds snapshot retention (§2.3) like the plugin registry does.

- **Install and load.** An install writes the files, then the ledger, then
  activates; a failed activation puts the previous install back. At boot
  every package's files and digest are read again, and a package that no
  longer matches is listed as broken instead of applied. Uninstall refuses a
  `requiredInstalls` package (`PACKAGE_REQUIRED_BY_POLICY`).
- **Theme** — `theme.json` is `{ name, description, shell: "light" |
  "dark", highContrast, tokens, surfaces, preview? }`. `tokens` holds every
  one of the compiled bundles' token names as `"H S% L%"`, `surfaces` the
  surface ladder (`surface-sunken` … `border-strong`). An installed theme is
  held to the same token contract and WCAG contrast rules as the compiled
  bundles (one table, `shared/theme-tokens.ts`); a built-in theme id is
  refused. It applies as inline custom properties with its shell's shadow
  stack and `color-scheme`.
- **Language** — the locale set is open: any well-formed BCP 47 tag. `en`
  and `ko` stay compiled in; an installed language registers its locale
  with its native and English names, and its messages are layered over
  English, so a key it does not translate reads in English. `messages.json`
  may only use English catalog keys; missing keys are listed, not refused.
  One package per locale. The main process uses installed locales too
  (dialogs, menus, notifications), and `<html lang>` follows the active
  locale.
- **Font** — `font.json` is `{ family, license, faces: [{ file, weight,
  style }] }`, with a `LICENSE` file required; a face's format comes from
  its extension and its bytes must match it. One package per family. The
  renderer declares `@font-face` rules with `ave-content:` URLs only.
- **Provider and messaging connection** go through today's normalizers,
  with no field dropped or rewritten, and take effect through the settings
  paths today's asset install uses.
- **Selection stays the user's.** Installing does not select a theme,
  language or font. Removing the selected one puts that setting back to its
  default; a selected id that is not installed renders the default.
- **Asset scheme.** `ave-content://<kind>/<name>/<path>` answers only the
  files the loaded store lists (font faces, theme previews), with `nosniff`;
  anything else is 404. The CSP admits it for `img-src` and `font-src` only.
  Its handler is registered with the IPC handlers, before the main window
  loads, because a frame binds its custom-scheme loaders when it commits.
- **Loading.** The store loads on the renderer's first request at boot (or
  the first asset request), not while IPC is registered, so a process that
  never asks reads nothing under `packages/`.
- Install and uninstall IPC arrive with the install surface (§13); until
  then two read-only channels expose installed content.

## 6. Resolution

### 6.1 Choosing a version

For a package row in one source snapshot:

1. Drop versions for which `appVersionSatisfiesMin(appVersion, minAppVersion)`
   is false.
2. Drop yanked versions (still shown in history; an installed yanked version
   keeps running and shows "yanked" with the reason).
3. Drop versions whose `platforms` excludes the current OS.
4. Drop pre-release versions unless `marketplace.canaryOptIn` is on.
5. Drop versions whose rollout excludes this installation:
   `bucket = uint32(sha256("${installationId}:${sourceId}:${kind}:${name}:${version}")[0..4]) % 100`;
   eligible when `bucket < percent`.
6. Drop versions the same source revokes (§10.4).
7. The highest remaining version is the **candidate**. If none remain but
   some were dropped only by step 1, the row shows `upgrade_required` with the
   newest version's `minAppVersion`. Otherwise the row is `unavailable` with a
   reason: `revoked` (every version revoked), `yanked` (every version yanked
   or revoked), `pending` (some version is held back only by its rollout or as
   a pre-release) or `withheld` (anything else). An install of the row fails
   with `PACKAGE_REVOKED`, `PACKAGE_YANKED` or `PACKAGE_INCOMPATIBLE` (§14).

### 6.2 Plugin artifact ladder

```
plan = { snapshotCommit, versionCommit, rungs: [] }        // fixed at plan time
for rung in [release, archive, tree]:
  if rung not declared                               -> skip(rung, NOT_DECLARED)
  if rung in {release, archive} and no sha256 pin    -> skip(rung, ARTIFACT_NOT_PINNED)
  fetch rung                                          // every URL passes §7.4 first
    release: https GET (token only to the origin host; auth headers stripped on cross-host redirects)
    archive: https GET (same rule)
    tree:    export `tree` at versionCommit (§9.3)
  on transport error                                 -> fail(rung, SOURCE_UNREACHABLE / …) and continue
  verify
    release/archive: sha256(zip) == pin, zip limits, entry paths
    tree:            file rules, no links, digest computed (§6.4)
  on verification error                              -> fail(rung, ARTIFACT_DIGEST_MISMATCH / …) and continue
  stage, then compare plugin.json with the descriptor:
    name, version, requires.minAppVersion, every PluginAuthority field
  on mismatch                                        -> stop with MANIFEST_MISMATCH (do not try lower rungs)
  return staged artifact
stop with NO_INSTALLABLE_ARTIFACT(rungs[])
```

- The plan records `snapshotCommit` and the version's commit. Execution uses
  only those, so a sync that moves the pin between plan and execute cannot
  change what is installed.
- A manifest mismatch stops the ladder: the package is inconsistent, and
  trying another rung would hide that.
- Every rung outcome (`used`, `skipped: reason`, `failed: code`) is part of
  the plan shown to the user and is written to the receipt.
- Dependency preflight (`dependency-resolver.ts`, `requires.capabilities`)
  runs on the descriptor's authority before any download, as it runs on the
  catalog row today.
- Before any rung, the descriptor at the version's commit must say what the
  index copy says (kind, name, version, `minAppVersion`, `platforms`,
  `authority`, `artifact`); a difference is `MANIFEST_MISMATCH`. Every kind
  other than plugin reads its payload from that descriptor.
- The tree rung is declared by `artifact.tree`, or by a `plugin.json` in the
  package directory (its default). It installs `plugin.json`, `dist/**` and
  `assets/**`; any other top-level entry fails the rung, and
  `ave-package.json` is not installed. The layout and the file count are
  checked from the tree before any blob is downloaded, so a direct source at
  a repository root cannot make the client fetch the whole repository before
  refusing it. The byte total is known only once the blobs arrive, so, as
  in §5.4, the fetch timeout bounds the transfer. The exported files are packed into a zip, so every rung goes
  through the same zip preflight and install pipeline.
- `release.sha256` and `archive.sha256` are optional in the schema: a
  declared rung without a pin is skipped as `ARTIFACT_NOT_PINNED`, and the
  ladder moves on.
- A release without `url` is fetched from
  `<origin>/<repo>/releases/download/<tag>/<asset>`. The origin is the
  source's own for an https source (or a policy-listed http host), and
  `https://<host>` on the default port for an ssh source, whose ssh port
  says nothing about the web server. `repo` is `owner/name`, and neither
  segment may be `.` or `..`. When the source uses token auth on
  `github.com` and a token is stored, the asset comes through the GitHub
  REST API instead — `api.github.com/repos/<repo>/releases/tags/<tag>` for
  the asset id, then `…/releases/assets/<id>` with
  `Accept: application/octet-stream` — because that is what serves a private
  repository; the storage host it redirects to never receives the token
  (§7.4). Before that request the policy is checked against
  `https://github.com/<repo>/releases/download/…`, so a repository block
  rule applies to this path too. A policy allow list must admit
  `api.github.com` for it.
- Release and archive downloads are bounded by the artifact limits and fail
  after 60 s without data.

### 6.3 Official release flow

1. The plugin's own repository tags `vX.Y.Z`; its release workflow builds
   `{name}-{X.Y.Z}.zip` and uploads it as a release asset of **that**
   repository.
2. The official marketplace's `release-pin` workflow (or a human) opens a PR
   that sets `plugins/<name>/ave-package.json` `version`, `minAppVersion`,
   `authority` and `artifact.release` (`repo`, `sha256`), computed from the
   downloaded asset.
3. CI verifies the asset hash, unpacks it, checks `plugin.json` against the
   descriptor, and regenerates the index.
4. Merge = publish.

### 6.4 Tree digest

For the tree rung, `artifactSha256` is `sha256` over the lines
`"<mode> <sha256(file)> <path>\n"` for every installed file (the descriptor
is not installed), sorted by path bytes, with
`mode` ∈ {`100644`, `100755`}. It is recorded in the receipt and lets a later
reinstall of the same version prove it got the same bytes.

## 7. Source lifecycle

### 7.1 URL normalization

One function, `normalizeSourceUrl(input)`, produces
`{ scheme: "https" | "ssh" | "http", host, port, path }` and the stored
string:

- `owner/repo` → `https://github.com/owner/repo`.
- scp form `user@host:path` → `ssh://user@host/path`.
- host: lowercase, IDNA to ASCII, default port removed.
- path: percent-encoding normalized, trailing `/` and `.git` removed.
- rejected: `file:`, `ext::`, any other scheme, credentials in the URL, query
  and fragment.

Policy allow/block matching (§12), reserved-name checks, token lookup and
duplicate detection all use the normalized form. Repository identity in those
comparisons is the host plus the path compared without case, on any scheme and
port (§12).

### 7.2 Add (preview → confirm)

1. **Normalize** the input (§7.1) and apply the network gate (§7.4). Plain
   `http://` is accepted only for a host listed in
   `marketplaces.allowHttpHosts`; dev/test builds may also allow loopback, as
   `cloudAllowPrivateNetwork` does today.
2. **Probe** with `git ls-remote`. Auth failure returns `SOURCE_AUTH_REQUIRED`
   and the dialog asks for a token; an unknown SSH host key returns
   `SOURCE_SSH_HOST_UNKNOWN`; a missing ref returns `SOURCE_REF_NOT_FOUND`.
3. **Fetch** the ref into a temporary bare repo and read the root.
4. **Classify**: marketplace (index or conventional layout) → preview; single
   package (descriptor, `plugin.json`, `SKILL.md`, `AGENTS.md`, `server.json`
   at the root or the given subdir) → direct-install preview; otherwise
   `SOURCE_NOT_A_MARKETPLACE`.
5. **Preview** returns a `previewId` (single use, expires after 10 minutes;
   the temporary repo is deleted on expiry or cancel), the resolved commit,
   marketplace name and owner, package counts per kind, how many packages
   execute code (plugins + MCP), and validation diagnostics.
6. **Confirm** writes the entry, writes the source's `state.json`, then moves
   the temporary repo into place and publishes the snapshot (a `repo.git`
   without a state is read as lost state, §2.1). The id defaults to the index
   `name`; a reserved or taken id (`SOURCE_ID_TAKEN`) makes the dialog ask for
   another, and a malformed one is `SOURCE_ID_INVALID`.

### 7.3 Sync

Triggered after boot (non-blocking), every `marketplace.updateCheckIntervalMs`
while running, and manually. The setting keeps its key and its `0` = no
periodic sync meaning, but a tick now fetches every source, so the code
default changes from today's 10 minutes to 6 hours and a stored value below
15 minutes is raised to 15 minutes when read. The setting is optional and
unset by default, so no stored value needs migrating. A source syncs while it is
enabled **or** while any installed package is bound to it, so revocations and
update notices keep reaching installed packages from a hidden source.

```
fetch ref with --filter=blob:none (full commit history, no --depth, no tags except the ref)
candidate = resolved commit
if candidate == pin: done
if not is_ancestor(pin, candidate):
  official, managed -> keep pin, SOURCE_HISTORY_REWRITTEN
  custom, direct    -> keep pin, set pendingRewrite; the user may accept it in the update review
parse + validate index at candidate
  invalid -> keep pin, SOURCE_INDEX_INVALID
write snapshots/<candidate>.json, then atomically set pin = candidate
emit marketplace:catalog-changed
```

- Commits and trees are small without blobs, so the full history is fetched
  and the ancestry check never fails for lack of objects.
- For the official source the client tries the primary URL and then each
  mirror; any of them may supply the candidate, and the history rule applies
  unchanged.
- A pin whose commit is still missing after the full-history fetch (the
  repository directory was lost and the remote no longer has the commit)
  counts as rewritten history: without the object the ancestry cannot be
  proven, and a first sync would accept any history. When the candidate
  descends from the pin, the fetch brings the pin back and ancestry is proven
  as usual.
- The update review accepts exactly the commit it showed
  (`ave:marketplace:sources:accept-rewrite` carries it); a sync that saw a
  different candidate in between expires the review (`PLAN_EXPIRED`).

### 7.4 Network targets and policy

Every network target the marketplace touches — git remotes, release and
archive URLs, and the service endpoint — goes through one gate:

1. normalize (§7.1; for `https` downloads, the same host/port/path rules:
   canonical percent-encoding, and an empty, `.` or `..` segment is refused);
2. apply managed policy `marketplaces.block`, then `marketplaces.allow` (when
   present). For a download, an exact repository pattern also covers every
   path beneath the repository (`…/acme/tools/releases/download/…`); for a
   git remote it names that repository only, since a nested path is another
   repository on hosts with subgroups;
3. apply the private-network guard now in `cloud-marketplace-fetcher.ts`
   (moved to a shared module when that file is deleted): loopback,
   link-local, private and metadata addresses are refused unless the host is
   policy-listed or a dev build allows loopback. A NAT64 address
   (`64:ff9b::/96`) is judged by the IPv4 address it embeds;
4. git never follows redirects (`http.followRedirects=false`); HTTPS
   downloads follow a redirect only after re-running this gate on the new
   URL, and never forward auth headers to a different host.

Icons and images are read from the git tree only; no package field makes the
app fetch an arbitrary image URL.

### 7.5 Offline

The last good snapshot is served. Installing a package whose bytes are not
already fetched fails with `SOURCE_UNREACHABLE`; nothing falls back to a
different source.

### 7.6 Remove

Removing a source keeps the packages installed from it. They show "source
removed — no updates", and the Installed view offers uninstall. Re-adding the
same normalized URL re-binds them. Official and managed sources cannot be
removed. A removal waits for a running sync or accept of that source to
finish, so no write of the old source lands after its directory is gone.

## 8. Direct install (no marketplace manifest)

### 8.1 Inputs

| Input | Detection | Result |
|---|---|---|
| Git URL (+ optional subdir, ref) | first match at the path: `ave-package.json` → `plugin.json` (Agent Plugins) → `SKILL.md` → `AGENTS.md` → `server.json` | a `direct` source entry for that package |
| MCP: command / URL form | existing MCP tab form | MCP server entry (unchanged path) |
| MCP: pasted `server.json` | MCP Registry schema | MCP server entry; npm/PyPI/OCI packages map to `npx`/`uvx`/`docker`; `remotes` map to `http` |
| MCP: pasted client config | an `mcpServers` object (desktop client config or a project `.mcp.json`) | reuse `claude-desktop-import.ts` preview/apply |

### 8.2 Synthesized descriptor

- `ave-package.json` present → used as is.
- `plugin.json` → `kind: "plugin"`; `name`, `version`, `authority` and
  `minAppVersion` come from it (`requires.minAppVersion` missing →
  `PACKAGE_COMPAT_UNDECLARED`). Artifact: the tree rung, unless the resolved
  commit also holds an `ave-package.json` with `artifact.release.sha256`. The
  usual flow is: tag, publish the release asset, then commit the pinned
  descriptor; the user's ref must include that later commit.
- `SKILL.md` / `AGENTS.md` → `version` from front matter if present, else
  `0.0.0+g<commit12>`; `minAppVersion` defaults to `0.0.0` for these
  non-executing kinds.
- `server.json` → `version` from the file; `minAppVersion` `0.0.0`.

A direct package updates when its ref moves to a descendant commit that
declares a higher version (or any new commit for synthesized `0.0.0+g…`
versions), after the same update review as marketplace packages.

## 9. Git runtime

### 9.1 Detection and minimum version

The minimum usable git is **2.45.1**, the first release that honors
`GIT_NO_LAZY_FETCH` (§9.3): without it, a local read of a missing object in a
partial clone fetches from the remote on its own, outside the network gate.
It is also the release that fixed CVE-2024-32002/32004/32465. Partial clone
with `blob:none`, `rev-list --missing=print`, protocol v2 and
`protocol.file.allow` behave as §9.3 relies on well before that.

```
mode = settings.marketplace.git.mode   // "auto" | "system" | "managed"
system: first `git` on PATH (plus /usr/bin/git, /opt/homebrew/bin/git,
        C:\Program Files\Git\cmd\git.exe); require `git --version` >= 2.45.1
managed: ~/.ave/runtime/git/<pinnedVersion>/ present and smoke-tested
auto: system if usable, else managed if present, else state "missing"
      (a system git older than 2.45.1 is reported as too old and auto uses managed)
```

On macOS, `/usr/bin/git` without the Command Line Tools is a shim that opens an
installer dialog; detection runs `xcode-select -p` first and treats a missing
CLT as "no system git" instead of triggering the dialog.

### 9.2 Managed provisioning

```ts
// src/marketplace/git/managed-git-pins.ts — updated deliberately, reviewed like a dependency bump
const RELEASE = "https://github.com/desktop/dugite-native/releases/download/v2.53.0-4/dugite-native-v2.53.0-4098283";
const MANAGED_GIT = {
  version: "2.53.0",
  assets: {
    "darwin-arm64": { url: `${RELEASE}-macOS-arm64.tar.gz`,    sha256: "f9dc6463…", size: 62348987 },
    "darwin-x64":   { url: `${RELEASE}-macOS-x64.tar.gz`,      sha256: "ae668671…", size: 66136060 },
    "linux-x64":    { url: `${RELEASE}-ubuntu-x64.tar.gz`,     sha256: "cca76aa3…", size: 65269219 },
    "linux-arm64":  { url: `${RELEASE}-ubuntu-arm64.tar.gz`,   sha256: "a161f45a…", size: 23223345 },
    "win32-x64":    { url: `${RELEASE}-windows-x64.tar.gz`,    sha256: "7b76bc5c…", size: 47119821 },
    "win32-arm64":  { url: `${RELEASE}-windows-arm64.tar.gz`,  sha256: "1abbeb3a…", size: 45084825 },
  },
};
```

One source for every platform: desktop/dugite-native, the git build GitHub
Desktop ships. Its Windows archives are MinGit (Git for Windows) repacked as
tar.gz, so one extractor serves every platform. Each `sha256` is read from the
release's own `<asset>.sha256` file and matched against the digest GitHub
reports for the asset; `size` is exact, so a longer body is cut off and a
shorter one fails the hash.

Phases reported to the UI: `checking → downloading(bytes) → verifying →
extracting → smoke-testing → ready | failed(code)`. Download goes through the
PAC-aware single-hop transport and the §7.4 gate (GitHub answers with a
redirect to its asset host, which the gate checks again). Extraction goes to
a staging directory next to the target and accepts only regular files,
directories and symlinks that name a sibling (`git-fetch -> git`). The smoke
test runs the staged copy: `--version` equals the pin, `hash-object --stdin`
agrees with git's object format, and the https transport helper exists. Only
then is a ready marker written and the directory renamed into place. A failed
or partial install never replaces a working one; a forced reinstall moves the
working copy aside and restores it if the final rename fails. Every download,
verify, extract or smoke-test failure is `GIT_RUNTIME_INSTALL_FAILED`, except
a policy block, which stays `SOURCE_POLICY_BLOCKED`. A body that sends nothing
for 60 s fails the install instead of holding it open. The download is gated
like the official source: `block` and `allow` apply, and an invalid policy
does not stop it, because the official source needs git and the archive is
pinned by hash.

Managed-mode environment, set on every call:

- macOS and Linux run `bin/git` with `GIT_EXEC_PATH` = `libexec/git-core`;
  Windows runs `cmd/git.exe` with `GIT_EXEC_PATH` = `mingw64/libexec/git-core`
  and `PATH` prefixed with `mingw64/bin` and `usr/bin` (which holds
  `ssh.exe`). `GIT_TEMPLATE_DIR` = an empty Ave-owned directory everywhere.
- CA roots, as measured on the pinned build (2026-09-23):
  - macOS: `git-remote-http` links the system libcurl (SecureTransport), so
    the keychain is used as is, including a corporate root in the System
    keychain. No CA file is set; one would narrow the trust.
  - Linux: the copy ships `ssl/cacert.pem` and reads no OS store.
    `GIT_SSL_CAINFO` = an Ave-built bundle of those roots plus the corporate
    roots `src/main/corp-ca-extract.ts` finds.
  - Windows: `-c http.sslBackend=schannel`, the Windows certificate store. The
    copy's own system config says the same, but `GIT_CONFIG_NOSYSTEM=1` keeps
    that file unread, so the setting is passed on every call.

### 9.3 Invocation contract

Every call goes through one function, `runGit(args, { cwd, sourceId })`.

Environment (both modes):

- `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=<Ave-generated file>` (below), `LC_ALL=C`.
- `GIT_ASKPASS=<Ave askpass helper>`, `SSH_ASKPASS_REQUIRE=never`,
  `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` (an unknown host key fails fast
  with `SOURCE_SSH_HOST_UNKNOWN` instead of waiting for a prompt).
- `GIT_ALLOW_PROTOCOL=https:ssh`, plus `http` only when the source's host is
  in `marketplaces.allowHttpHosts`; `none` for a call that has no remote.
- `GIT_LFS_SKIP_SMUDGE=1`.
- `GIT_NO_LAZY_FETCH=1`: a missing object is an error, never a fetch the gate
  did not see. Blobs are fetched only by the explicit, gated `ensureBlobs`
  step.
- `GIT_DIR=<source repo.git>` for every call on a repository, so git never
  discovers another repository by walking up from a broken one; other calls
  run in the empty directory with `GIT_CEILING_DIRECTORIES` stopping
  discovery there.

Config flags: `-c protocol.file.allow=never -c submodule.recurse=false
-c core.fsmonitor=false -c core.hooksPath=<empty dir> -c http.followRedirects=false
-c http.proxy=<PAC> -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false
-c gc.auto=0 -c maintenance.auto=false` (automatic gc could prune a commit that
an install still references once the pin has moved on), plus
`-c credential.helper=` on a call that answers with a stored token (below).
`<PAC>` is the first entry Chromium resolves for the remote: `PROXY`,
`HTTPS`, `SOCKS5`, and `SOCKS`/`SOCKS4` as `socks4://`; `DIRECT` is empty. Any
other kind fails the call with `SOURCE_UNREACHABLE` rather than going direct
where the configuration chose a proxy.

**Global configuration.** The user's global git config is not read. Ave
generates the file named by `GIT_CONFIG_GLOBAL` and copies into it only
`credential.helper` and `credential.<url>.*` entries (so OS credential
helpers keep working), `http.sslCAInfo` and `http.sslBackend`, read from the
system and global levels in that order (Apple's and Homebrew's git configure
the keychain helper at the system level, which `GIT_CONFIG_NOSYSTEM=1` would
otherwise drop). Everything
else — `url.*.insteadOf`, `http.extraHeader`, `http.sslVerify`,
`core.sshCommand`, aliases, hooks — is dropped. A stored OS credential for a
host is therefore available to every source on that host; the add dialog says
so when a credential helper is configured.

**Askpass protocol.** The helper is a small script that the main process
writes, with a launcher, into a fresh `0700` directory at start-up; the
launcher runs it with the app binary in Node mode (`ELECTRON_RUN_AS_NODE`),
so nothing extra ships with the app.
A call gets a ticket only when its source declares token auth and a token is
stored for the remote's host; a mirror on another host never gets the
primary host's token. That call also carries `-c credential.helper=`, which,
read last, switches the copied helpers off: git neither asks them first nor
hands the token to them when it approves a credential. Without a stored
token the helpers answer as usual.
For each such call the main process creates a single-use ticket bound to
`(normalized host, sourceId)` and passes `AVE_ASKPASS_TICKET` and
`AVE_ASKPASS_ENDPOINT` (a local socket in a `0700` directory) in the child
environment. The helper sends the ticket and git's prompt text; the main
process answers with the stored token only if the prompt names the ticket's
host, and with an empty answer otherwise. Tickets expire when the git process
exits.

**Commands used** (nothing else):

- `ls-remote`
- `init --bare`
- `fetch --filter=blob:none --no-tags <remote> <ref>`
- `rev-parse`, `merge-base --is-ancestor`, `cat-file`, `ls-tree`
- **Export of a path at a commit:**
  `rev-list --objects --missing=print --no-walk --sparse <commit> -- <path>`
  lists the blobs not yet present (`--no-walk` keeps historical versions out;
  `--sparse` keeps the commit when it did not change the path); they are
  fetched in one request
  (`fetch --filter=blob:none --no-tags <remote> <oid>…`, the request that
  partial-clone lazy fetching issues; it needs a server that allows filters
  and fetching by object id, which hosted services do. A self-hosted ssh or
  `git daemon` server that ignores the filter sends full blobs instead, which
  is slower but correct); the listing is repeated to prove nothing is still
  missing; then `archive --format=tar --prefix=<path>/ <commit>:<path>` writes
  the tree into a staging directory (the `<commit> -- <path>` form also reads
  blobs outside the path). No worktree and no sparse-checkout is created.
  Only regular files and directories are accepted; a symlink or submodule
  entry in the tree stops the export.

Timeouts: `ls-remote` 20 s, `fetch` 120 s (configurable), export 60 s. Output
limits and abort signals follow the existing process helpers.

## 10. No privileged packages

The official source is hard-coded in the app and carries the **Ave
Official** badge. The badge is the only thing it grants: packages from the
official source are resolved, verified and consented to exactly like packages
from any other source. Decisions that used to arrive with the catalog now
live in the app's own source code or in the machine's system policy file,
where a git repository cannot reach them.

### 10.1 Removed: managed packages

Today a catalog row with `installPolicy: "admin"` is installed at boot without
user action (`ensureManagedInstalled`), cannot be uninstalled by the user
(`deployment-guard.ts`), skips the grant tier of the secret gate
(`secret-gate.ts` admin bypass), escalates user update clicks to the managed
actor, and is removed when delisted. All of this is removed:

- `installPolicy` leaves the manifest schema (§5.3); `installSource: "admin"`
  leaves the registry (§16.3).
- No package can lock itself against uninstall. Only the machine's system
  policy file can require a package (§10.2). No package reaches host secrets
  except through the manifest allowlist, the app's grant table (§10.3) and the
  active-vendor check.

Removal points (verified in the current tree): `src/boot/managed-marketplace.ts`;
the managed branches of `src/plugins/marketplace.ts` (boot install and update,
delisted removal, user→it-admin actor escalation); `update-condition.ts`
(`eligible_managed_install`, `eligible_managed_boot_update`, the
`normalizeInstallPolicy` check); `runtime/index.ts` `isManaged`;
`runtime/manifest-validation.ts` `normalizeInstallPolicy`; the
`installPolicy` fields in `src/ui/renderer/types.ts`; the `installSource`
bridge and `admin-bypass` audit path in
`src/boot/steps/plugin-runtime/host-api-factory.ts`; the admin branch of
`deployment-guard.ts`; the tier-3 bypass in `secret-gate.ts`; the
`installPolicy` property in `schemas/sdk/skill-package.schema.json` and its
SDK copy (same change in both repositories). Tests that assert managed
behavior are rewritten, not deleted, to assert §10.2:
`marketplace-managed-bootstrap`, `marketplace-install-actor-escalation`,
`deployment-guard`, `registry-migration`, `secret-gate`.

### 10.2 Default and required installs

Which packages a fresh installation starts with is decided by lists outside
any repository. There are two kinds.

**Default installs** are installed once and then belong to the user. They
come from the app:

```ts
// src/marketplace/default-installs.ts — changed only by an app release
export const DEFAULT_INSTALLS: readonly PackageKey[] = [
  { kind: "plugin", name: "meeting", source: "ave" },
  { kind: "plugin", name: "local-indexer", source: "ave" },
];
```

and the system policy file's `marketplaces.defaultInstalls` (§12), which may
name packages from the official or a managed source.

- At boot, each listed key that is not yet recorded in
  `packages/default-installs.json` is installed through the normal plan
  (ladder, verification, receipt), then recorded. The user sees one notice
  listing what was installed, with Uninstall next to each item.
- A recorded key is never installed again: uninstalling a default package is
  final unless the user installs it again.
- A key whose package is missing or incompatible is recorded as `skipped` and
  retried only when the list entry changes.
- A key whose source has no snapshot yet (a first boot offline), whose
  versions are only held back by their rollout or as pre-releases (the row is
  `unavailable` with reason `pending`, which can change without the app
  changing), or whose install failed is not recorded and is tried again at
  the next boot. A
  `default-installs.json` that cannot be read stops the default installs:
  reading it as empty would reinstall what the user removed.

**Required installs** come only from the system policy file's
`marketplaces.requiredInstalls` (§12). The file is owned by the machine's
administrator (root or device management), which no git repository can write.
For each entry:

- It is installed at boot if absent and updated at boot to the source's
  candidate version (§6.1), through the normal plan. Permission consent for a
  required package is given by the policy, and the review sheet shows it as
  "required by your organization".
- The user cannot uninstall or disable it: `deployment-guard.ts` keeps its
  actor model, but the only reason that denies a user action becomes "listed
  in `requiredInstalls`" (`PACKAGE_REQUIRED_BY_POLICY`), returned by
  `PluginDeploymentGuard.canUninstall` and `canDisable`, and therefore by the
  free function `assertDisableAllowed`, which calls `canDisable`.
- If the listed package is installed from another source
  (`PACKAGE_ID_CONFLICT`), the boot step performs the source switch of §15.1
  (plugin data kept) and records it in the boot notice; the policy wins over
  the user's source choice. Only such a required install may replace a
  plugin installed by an administrator (`installSource: "admin"`), and the
  entry stays admin-installed; any other git install over one is refused
  with `PACKAGE_ID_CONFLICT`. The install reads this from the managed policy
  it is given (the plugin's `requiredInstalls` entry, from the plan's
  source); a caller cannot claim it. A `defaultInstalls` entry in the same situation is
  recorded as `skipped`, because the user's install already satisfies it.
- A required update applies without the update review of §15.6: the policy
  file stands for the consent. A compromised managed source can therefore
  ship code to every machine that requires one of its packages without a
  prompt; the organization owns that source and its branch protection
  (architecture proposal §9.1).
- An entry may name the official source or a managed source only.
- Removing the entry from the policy file ends the requirement; the package
  stays installed and becomes an ordinary user install.

Being default or required gives a package no host-secret grant; grants
follow §10.3 only.

### 10.3 Host-secret grants

The signed whitelist grants (today: `meeting` and `local-indexer` may read
`llm.apiKey.*` for the active vendor) move into the app:

```ts
// src/plugins/secret-access/grants.ts — changed only by an app release
export const HOST_SECRET_GRANTS: readonly HostSecretGrant[] = [
  { plugin: "meeting", keys: ["llm.apiKey.openai", "llm.apiKey.claude", "llm.apiKey.gemini", "llm.apiKey.azure-foundry", "llm.apiKey.vertex-ai"] },
  { plugin: "local-indexer", keys: [/* same set */] },
];
```

A grant applies only when all of these hold:

1. the registry entry's `origin.sourceOrigin` is `official`;
2. the installed artifact's sha256 equals a sha256 the official snapshot
   pins for that version — its release or archive pin (the exact artifact
   Ave published). The value is
   read from `origin.artifactSha256`, or, for a `legacy` entry, from the
   existing install receipt's `artifactSha256`; a tree-rung install never
   qualifies;
3. the running manifest's canonical SHA-256 equals `manifestSha256` recorded
   at install (today's tier-3 pin, kept);
4. the key is in the manifest's `hostSecrets.read` (tier 2) and names the
   active vendor (tier 4), unchanged.

`canonical-json.ts` and `secret-gate.ts` stay and move to
`src/plugins/secret-access/`; the tier-3 lookup reads the table above instead
of `whitelistRegistry`.

- Condition 2 is ultimately defined by whoever can merge to the official
  repository's `main`: under D4 a merge that pins a different artifact for a
  granted plugin name grants that artifact. The grant table limits the blast
  radius to the listed plugin names and keys, and the proposal's threat table
  states this.
- A user who uninstalls a granted default package and installs it again from
  the official source gets the grant back when conditions 1–4 hold. This is
  intended.
- Adding a plugin or a key to the table requires an app release.

### 10.4 Revocation

Every source may publish `policy/revocations.json`. It applies **only** to
installs whose `origin.sourceId` is that source, so no repository can
disable another repository's packages. The official source has no wider
power.

```ts
interface RevocationsFile {
  schemaVersion: 1;
  revocations: Array<{ kind: PackageKind; name: string; versions: string; // semver range
                        reason: string; at: string; action: "disable" | "uninstall" }>;
}
```

`versions` is a range in this grammar:

```
range       := alternative ("||" alternative)*
alternative := "*" | comparator (" " comparator)*
comparator  := (">=" | ">" | "<=" | "<" | "=")? semver
```

Comparators in one alternative must all hold; any alternative may match;
precedence is the host's `compareSemver`, so a pre-release sorts below its
release. A range that does not parse makes the file invalid (§2.2).

A revoked installed version is disabled (or uninstalled) at boot through the
existing `revocationRegistry` interface, which is fed from snapshots instead
of the signed feed, and the user is told why.

There is deliberately no cross-source kill switch: neither the official
source nor the service endpoint can disable a package another source
published. A harmful package from a custom source is handled by the user
(uninstall, remove the source) or by device management
(`marketplaces.block` stops adding and syncing the source; removing installed
files is a device-management action).

### 10.5 What the official source still differs in

| Aspect | Official | Managed | Custom / direct |
|---|---|---|---|
| Badge | Ave Official | organization label | source id |
| Can the user remove it | no | no | yes |
| Can the user hide it | only if policy allows | no | yes |
| Rewritten history | refused | refused | user review |
| Default installs may name it | app list and policy list | policy list | no |
| Required installs may name it | policy list | policy list | no |
| Uninstall/disable lock | only via policy `requiredInstalls` | only via policy `requiredInstalls` | never |
| Host-secret grants apply | yes (§10.3) | no | no |
| Can revoke packages of other sources | no | no | no |

## 11. Service endpoint

```jsonc
// GET {serviceBase}/.well-known/former-service.json
{
  "schemaVersion": 1,
  "announcements": "/announcements/v1.json",   // path on the same origin
  "telemetry": null,                            // or "/telemetry/events" (same origin) when an ingestion service exists
  "movedTo": null,                              // or "https://new-domain.example" for a domain change
  "movedFrom": null                             // on the new domain: the previous base, confirming the move
}
```

- `serviceBase` resolution: managed policy `service.baseUrl` → the move
  recorded for the current build constant (below) → build constant
  `AVE_SERVICE_BASE_URL` (default `https://former-site.invalid`). There is no user
  setting.
- **Domain change.** A `movedTo` is accepted only over https from the current
  base, and only after the new base's own service document names the current
  base in `movedFrom`. The accepted move is stored together with the build
  constant it was made under and is discarded when an app update ships a
  different constant. At most one move is followed per build constant.
- `announcements` and `telemetry` must be paths on the service origin.
- Announcements keep the `MarketplaceAnnouncement` contract (levels,
  `startsAt`/`endsAt`, up to three navigation-only actions, app-version
  filtered actions) and the dismissed-ids behavior. Action labels fall back to
  the `en` label when the active locale is an installed language that the
  announcement does not carry. They are fetched after boot and every 6 hours.
- The static files live in the ave `web/` site
  (`web/public/.well-known/` and `web/public/announcements/`), deployed through
  its existing manual production gate.

## 12. Managed policy additions

```jsonc
// policy.json (system scope)
"marketplaces": {
  "allow": ["https://github.com/acme/*", "host:git.corp.example"],  // absent = no restriction
  "block": ["host:git.example.org"],
  "allowHttpHosts": ["git.corp.example"],                           // plain-http git hosts; default none
  "allowDirectInstall": true,
  "allowDisablingOfficial": false,
  "additional": [{ "id": "corp", "url": "https://git.corp.example/ave/marketplace.git" }],
  "defaultInstalls": [{ "kind": "plugin", "name": "wiki-search", "source": "corp" }],
  "requiredInstalls": [{ "kind": "plugin", "name": "orion-api", "source": "corp" }]
},
"service": { "baseUrl": "https://ave.corp.example" }
```

- Patterns match repository identity (§7.1): the host plus the path compared
  without case, on any scheme and port. `https://github.com/acme/tools`,
  `git@github.com:acme/tools` and `https://github.com/ACME/Tools` are one
  repository on every hosting service Ave targets, so no respelling of a
  host's URL sidesteps a rule. A rule cannot know every other name that
  reaches the same repository — `ssh://git@ssh.github.com:443/…`,
  `altssh.gitlab.com`, a DNS alias, an `~/.ssh/config` `HostName` — so
  enforcement that must hold uses `allow`, which such a name fails.
  `host:<host>` matches the host; a URL pattern matches that
  repository; a URL ending in `*` matches every repository whose path starts
  with the text before it. A `*` anywhere else is rejected. `block` wins over
  `allow`.
- Policy-listed hosts — those named by `allowHttpHosts`, by an `allow`
  pattern, or by an `additional` source — may resolve to private (RFC 1918,
  ULA) and CGNAT addresses (§7.4). Link-local and metadata addresses stay
  refused even for them.
- Host fields (`host:` patterns, `allowHttpHosts`, `auth.host`) take no port;
  a token's `auth.host` must be the source's own host.
- The section is read exactly. An unknown key, a duplicate key, `null` where a
  list belongs, a pattern that does not parse, an `additional` source that the policy's own lists block, or
  an install entry naming a source that is neither official nor `additional`
  makes the whole section invalid; every non-official source is then
  `SOURCE_POLICY_BLOCKED` until the file is fixed. A typo must not fail open.
- `additional` sources are pre-registered with origin `managed`: the user
  cannot remove or hide them and their history rule is the official one.
- `defaultInstalls` and `requiredInstalls` follow §10.2 and may name official
  and managed sources only. A key in both lists is treated as required.

## 13. IPC contract

| Channel | Request | Response |
|---|---|---|
| `ave:marketplace:sources:list` | — | `SourceView[]` |
| `ave:marketplace:sources:preview` | `{ input: string; ref?: string; token?: string }` | `SourcePreview \| DirectPackagePreview` |
| `ave:marketplace:sources:add` | `{ previewId: string; id?: string }` | `SourceView` |
| `ave:marketplace:sources:remove` | `{ id }` | `{ orphanedPackages: PackageKey[] }` |
| `ave:marketplace:sources:set-enabled` | `{ id; enabled }` | `SourceView` |
| `ave:marketplace:sources:refresh` | `{ id? }` | `SyncResult[]` |
| `ave:marketplace:sources:accept-rewrite` | `{ id; commit }` | `SourceView` |
| `ave:marketplace:sources:set-token` / `delete-token` | `{ host; token? }` | `{ ok: true }` |
| `ave:marketplace:catalog:list` | `{ kind?; sourceId?; query?; installedOnly? }` | `CatalogRow[]` |
| `ave:marketplace:package:detail` | `PackageKey` | `PackageDetail` (versions, compatibility, provenance, authority, rung preview) |
| `ave:marketplace:install:plan` | `PackageKey & { version? }` | `InstallPlan` (includes `snapshotCommit`, `versionCommit`) |
| `ave:marketplace:install:execute` | `{ planId }` | `InstallResult` |
| `ave:marketplace:update:plan` | `PackageKey` | `UpdatePlan` (commit range, authority delta, pending rewrite) |
| `ave:marketplace:uninstall` | `PackageKey` | `UninstallResult` |
| `ave:marketplace:direct:preview` | `{ input; subdir?; ref? } \| { serverJson: string } \| { mcpConfig: string }` | `DirectPackagePreview` |
| `ave:marketplace:announcements` | — | `MarketplaceAnnouncement[]` |
| `ave:marketplace:content:installed` | — | `{ ok: true; content: InstalledContent } \| { ok: false; error: "installed-content-unavailable" }` (themes, languages, fonts, broken packages; §5.5) |
| `ave:marketplace:content:language-messages` | `locale` | `{ ok: true; messages } \| { ok: false; error: "installed-content-unavailable" \| "language-not-installed" }` |
| `ave:git:runtime:status` | — | `GitRuntimeStatus` |
| `ave:git:runtime:install` | — | `GitRuntimeStatus` (progress via event) |

Events: `marketplace:sync-progress`, `marketplace:catalog-changed`,
`marketplace:install-progress` (`{ planId, rung, phase, bytes? }`),
`marketplace:updates-available` (kept), `marketplace:boot-installs-applied`
(default and required installs),
`git-runtime:progress`.

All channels are host-renderer only (`validateHostRendererSender`) and
audited as today. `ave:git:runtime:install` also requires a live keyboard
gesture: it downloads a binary the marketplace then runs. `planId` and `previewId` are single use and expire after 10
minutes (`PLAN_EXPIRED`). Disposition of today's channels is in §16.2.

## 14. Error codes

| Code | When | User message (en key) |
|---|---|---|
| `GIT_RUNTIME_MISSING` | no usable git | `marketplace.error.gitMissing` |
| `GIT_RUNTIME_TOO_OLD` | system git older than 2.45.1 in `system` mode | `marketplace.error.gitTooOld` |
| `GIT_RUNTIME_INSTALL_FAILED` | managed download/verify/extract/smoke test failed | `marketplace.error.gitInstallFailed` |
| `SOURCE_URL_REJECTED` | scheme, credentials in URL, private-network target | `marketplace.error.urlRejected` |
| `SOURCE_POLICY_BLOCKED` | managed policy allow/block | `marketplace.error.policyBlocked` |
| `SOURCE_NAME_RESERVED` | reserved id | `marketplace.error.nameReserved` |
| `SOURCE_ID_INVALID` | id is not 2–63 lowercase letters, digits or `-` | `marketplace.error.idInvalid` |
| `SOURCE_ID_TAKEN` | id already used | `marketplace.error.idTaken` |
| `SOURCE_AUTH_REQUIRED` | 401/403, ssh denied | `marketplace.error.authRequired` |
| `SOURCE_SSH_HOST_UNKNOWN` | host key not in known_hosts | `marketplace.error.sshHostUnknown` |
| `SOURCE_REF_NOT_FOUND` | branch or tag missing | `marketplace.error.refNotFound` |
| `SOURCE_UNREACHABLE` | network, DNS, timeout | `marketplace.error.unreachable` |
| `SOURCE_NOT_A_MARKETPLACE` | nothing recognizable | `marketplace.error.notMarketplace` |
| `SOURCE_INDEX_INVALID` | index failed validation | `marketplace.error.indexInvalid` |
| `SOURCE_HISTORY_REWRITTEN` | non-descendant candidate | `marketplace.error.historyRewritten` |
| `SOURCE_DISABLED` | install or update requested from a hidden source (it still syncs for packages bound to it, §7.3) | `marketplace.error.sourceDisabled` |
| `PLAN_EXPIRED` | plan/preview id expired or reused | `marketplace.error.planExpired` |
| `PACKAGE_INCOMPATIBLE` | no version is offered to this installation: `minAppVersion` above the app version, another platform, a pre-release without canary, or a rollout that excludes it | `marketplace.error.incompatible` |
| `PACKAGE_COMPAT_UNDECLARED` | git-installed plugin without `requires.minAppVersion` | `marketplace.error.compatUndeclared` |
| `PACKAGE_YANKED` / `PACKAGE_REVOKED` | every version is yanked or revoked (revoked when all are revoked) | `marketplace.error.yanked` / `.revoked` |
| `PACKAGE_ID_CONFLICT` | same `(kind, name)` installed from another source, or from no source; also a signed-catalog install, update or rollback over a git-bound plugin | `marketplace.error.idConflict` |
| `PACKAGE_REQUIRED_BY_POLICY` | uninstall or disable of a `requiredInstalls` package | `marketplace.error.requiredByPolicy` |
| `ARTIFACT_NOT_PINNED` | rung skipped: no sha256 in git | (rung detail) |
| `ARTIFACT_DIGEST_MISMATCH` | sha256 differs | (rung detail) |
| `MANIFEST_MISMATCH` | plugin.json vs descriptor | `marketplace.error.manifestMismatch` |
| `NO_INSTALLABLE_ARTIFACT` | every rung skipped or failed | `marketplace.error.noArtifact` |
| `CONTENT_RULE_VIOLATION` | content kind file rules | `marketplace.error.contentRule` |

## 15. UI specification

The mockup shows every state below. Settings → Marketplace becomes the in-app
store (the web store is gone).

### 15.1 Browse

- Header: search field, **Sources** button, **Add** menu (Add marketplace…,
  Install from Git URL…, Add MCP server…), source filter chips (All sources +
  one per enabled source).
- Kind tabs: Plugins, MCP, Skills, Agents, Themes, Fonts, Languages,
  Providers, Messaging — each with a count.
- Card: icon, display name, one-line description, **source badge**
  (`Ave Official` with a shield glyph; managed sources with a building glyph
  and their label; custom sources their id), version, state chip: `Install`,
  `Installed`, `Update 1.4.2`, `Requires Ave 0.12`, `Yanked`,
  `Installed from <other source>`, `Source removed`, `Required by your
  organization` (no Uninstall or Disable control; the tooltip names the
  policy file).
- Same name in two sources: two cards, each with its own badge. No merged row.
  Installing the second one is a source switch (`PACKAGE_ID_CONFLICT` explains
  it and offers the switch). The switch keeps the plugin's data directory, so
  the consent text says that the new source's code receives the data the
  installed plugin stored. Until phase 6 removes the signed catalog, the
  catalog never replaces a git-bound plugin (install, update or rollback):
  the user updates or rolls back through the bound source, or uninstalls
  first.
- The boot-install notice (§10.2) appears once as a banner listing what was
  installed or updated, split into "Installed for you" (default, with
  Uninstall) and "Required by your organization".

### 15.2 Package detail (sheet)

Sections: overview; **Provenance** (source, repository, path, commit short SHA
with the full SHA in a tooltip and a copy button, published date);
**Compatibility** (`minAppVersion` and verdict); **Permissions** (from the
descriptor's authority, before any download); **Delivery** (the rung list with
the rung that will be used); **Versions** (history with yanked and
incompatible markers).

### 15.3 Install progress

Inline in the sheet: rung rows with `skipped`/`failed`/`using` and a progress
bar for downloads; then the existing permission-review step; then result. A
failure shows every rung's reason and a copyable diagnostic.

### 15.4 Sources

Table: source (label, URL, origin badge), pinned commit (short SHA with
tooltip, relative time of last sync), package count, status (`Up to date`,
`Syncing`, `Unreachable — showing cached`, `Auth required`,
`History rewritten — review`), enabled switch, overflow (Refresh, Set token,
Remove). Official and managed rows have no Remove; the official switch is
locked unless policy allows; managed rows show a lock.

### 15.5 Add marketplace dialog

Step 1: URL field (accepts `owner/repo`), optional ref, auth radio
(None / Token / SSH). Step 2 (preview): marketplace name, owner, commit, counts
per kind, "N packages can run code on this computer" warning, a note when an
OS credential helper will answer for this host, diagnostics, id field. Confirm
button: **Add marketplace**. If the input is a single package, step 2 switches
to the direct-install preview. If git is missing, a blocking step (§15.7)
comes first.

### 15.6 Update review

Commit range, version change, authority delta (capabilities, network,
secrets, tools) highlighted, and for custom sources a "history rewritten"
banner that requires an explicit checkbox.

### 15.7 Git runtime

A card in Settings → Marketplace → Maintenance and the blocking step inside
the Add dialog: detected state (`System git 2.50.1`, `Managed git 2.53.0`,
`Not found`, `System git 2.34.1 is too old — using managed git`), mode selector
(Auto / System / Managed), **Install Git (<size>)** — the pinned archive's
size for this platform, 23–66 MB — with the phase progress of §9.2 including
`smoke-testing`, and a `failed` state with the error and Retry.

### 15.8 Announcements

Unchanged banner component; the only difference is the fetch origin.

### 15.9 Accessibility and copy

All dialogs are focus-trapped with labelled steps; source badges carry a text
label (not color alone); SHAs use monospace with a tooltip of the full value;
state chips use the existing token colors. New copy is added to the i18n
catalogs through the generator; no raw keys.

## 16. Migration and disposition

### 16.1 Server features

| Today (server) | After |
|---|---|
| `GET /api/v1/catalog`, `/plugins/{slug}` | source snapshots |
| `…/download`, `…/download.sig` + `prod-v1` | ladder rungs + sha256 pins in git |
| `POST /plugins/{slug}/versions` + approval queue | PR + merge (D8) |
| yank / unyank / rollback | `versions[].yanked`, `policy/revocations.json`, a new version |
| canary rollout percentage, `channel: "canary"` | `versions[].rollout.percent` + local bucket; pre-release versions behind `canaryOptIn` |
| `min_app_version` column | `minAppVersion` in the descriptor and `requires.minAppVersion` in the plugin manifest |
| managed (`installPolicy: "admin"`) catalog rows | `DEFAULT_INSTALLS` in the app, policy `defaultInstalls` and policy `requiredInstalls` (§10.2) |
| internal visibility (CIDR) | an internal managed or custom marketplace |
| organization-allowed flag | managed policy `marketplaces.allow` |
| announcements | service endpoint |
| telemetry `/telemetry/events`, `register-device` | service document `telemetry` (null until a collector exists) |
| DLP hit reporting, API keys, `/me`, publisher routes | removed with the server |
| signed whitelist grants | `HOST_SECRET_GRANTS` in the app (§10.3) |
| signed admission / revocation feeds | §6 resolution; per-source `policy/revocations.json` |

### 16.2 App code and settings

| Item | Disposition |
|---|---|
| `cloud-marketplace-fetcher.ts` | delete; its private-network guard moves to the shared §7.4 gate |
| `LocalCatalogMarketplaceFetcher`, `DisabledMarketplaceFetcher` (`marketplace.ts`) | delete; dev builds use a local directory registered as a direct source under the dev flag |
| `marketplace-fetcher.ts` interface | replaced by the aggregated catalog view |
| `marketplace-installer.ts` | server download and `.sig` handling deleted; zip limit and entry checks kept for the release/archive rungs |
| `envelope-verifier.ts`, `marketplace-keys.ts`, `publisher-keys.ts`, `signed-doc-fetcher.ts`, `signed-doc-cache.ts` | delete; `plugin-artifact-store.ts` and `mcp-setup.ts` stop taking public keys |
| `admission/` | delete (install admission is the §6 resolution) |
| `whitelist/` | transport and registry deleted; `canonical-json.ts` and `secret-gate.ts` move to `src/plugins/secret-access/` with the grant table |
| `revocation/` | transport deleted; `revocationRegistry` fed from snapshots |
| `src/boot/steps/{admission,whitelist,revocation}-bootstrap.ts` | replaced by one step that feeds revocations from snapshots |
| `src/boot/managed-marketplace.ts`, `ensureManagedInstalled`, the managed actor escalation, delisted-admin removal | replaced by the boot-install step (§10.2) |
| `update-condition.ts` managed kinds, `runtime/index.ts` `isManaged`, renderer `installPolicy` types | removed; required installs use their own boot step |
| `deployment-guard.ts` admin branch | replaced by the `requiredInstalls` check in uninstall and disable |
| `secret-gate.ts` admin bypass, host-api-factory `admin-bypass` audit path, `normalizeInstallPolicy` | deleted |
| `mcp-marketplace-install.ts` (`readRuntimeFromVerifiedZip`) | replaced by `resolve/mcp.ts` |
| `offline-cache.ts` | replaced by snapshots and retained artifacts; `offlineCacheEnabled` means "keep downloaded artifacts" |
| `update-detector.ts`, `update-condition.ts` | kept, rewired to snapshots |
| `dependency-resolver.ts` | kept; runs on the descriptor's authority (§6.2) |
| settings `backend`, `cloudBaseUrl`, `cloudAllowPrivateNetwork` | removed by a settings migration |
| settings `updateCheckEnabled`, `updateCheckIntervalMs`, `canaryOptIn`, `skippedPluginUpdates`, `dismissedAnnouncementIds` | kept with the meanings above |
| settings `installedThemeBundleIds`, `installedLanguagePacks`, `installedProviderPresets`, `installedProviderIds` | converted to ledger entries |
| secret `marketplace.apiKey` and its IPC (`ipc/domains/settings.ts`) | deleted; telemetry no longer reads it |
| IPC `ave:plugins:marketplace:list`, `ave:plugins:install`, `ave:plugins:rollback` | replaced by `catalog:list` and `install:plan/execute`; rollback = installing a listed older version |
| IPC `ave:marketplace:ping` | replaced by `sources:refresh` results |
| IPC `ave:mcp:catalog:list`, `ave:mcp:install-from-marketplace`, `ave:agents:install`, `ave:skills:install` | replaced by `catalog:list` filtered by kind and `install:*` |
| IPC `ave:plugins:install-local`, MCP form, desktop config import | kept |
| deep links `ave://install/<type>/<slug>`, `ave://uninstall/<type>/<slug>` | become `ave://install/<kind>/<name>@<source>` and `ave://uninstall/<kind>/<name>@<source>`; both open confirming UI |
| `.github/workflows/marketplace-e2e.yml` | replaced in the same change as the switch by an in-repo E2E against a local git fixture |
| `resources/AGENTS.md` ("marketplace API" as the source of latest versions) | points at the installed sources' snapshots |
| `web/app/docs/servers/marketplace/*` | server admin/publisher pages removed; replaced by a package-author page for git marketplaces |
| `docs/architecture/architecture.md`, plugin development and publishing guides, `docs/ko/references/plugin-tool-schema-design.md`, the `installPolicy: "admin"` examples in `docs/ko/architecture/architecture.md` and `docs/ko/guides/plugin-development.md` | rewritten for the new model |

### 16.3 Existing installs

On first boot of the new version:

- Registry entries whose id exists in the official snapshot are bound to
  `ave` with `rung: "legacy"` and `artifactSha256: null`; the next update
  installs through the ladder and fills the origin. Nothing is reinstalled by
  the migration, and it works offline. Their installed manifests still carry
  `installPolicy`; the loader ignores it with one warning (§5.3).
- Grant continuity: a `legacy` entry keeps its host-secret grant when its
  install receipt's `artifactSha256` equals the official index's
  `artifact.release.sha256` for the installed version (§10.3 condition 2).
  The official index therefore carries `versions[]` entries for every version
  of a granted plugin that is still installed in the field; for each, the zip
  the current server serves is uploaded unchanged as that version's release
  asset and pinned by its sha256 (blueprint phase 0). An entry with no
  matching pin loses the grant until it updates, and the boot notice says
  which plugin lost which key.
- `installSource: "admin"` becomes `user`; the keys of those packages are
  written to `packages/default-installs.json` as already applied, so nothing
  is reinstalled or removed.
- Entries that match no official package — today the internal `orion` plugin —
  keep running as "source unknown — no updates", receive no grants, and are
  no longer locked. They stay that way until the organization registers its
  internal marketplace (`additional`) and lists them in `requiredInstalls`;
  the next boot then binds them to that source. The boot notice names these
  entries once: "<name> is no longer managed by Ave. Your organization can
  keep it up to date by registering its marketplace."
- Installed provider presets and theme/language activations become ledger
  entries.

## 17. Test plan

| Layer | What proves it |
|---|---|
| Schemas | fixture sets for every kind: valid, each invalid rule, unknown keys; a manifest with `installPolicy` is rejected by name at install and in the index CI; an installed legacy manifest with it loads with one warning |
| Version choice | table tests for `minAppVersion`, yank, platform, pre-release opt-in, rollout buckets, per-source revocations |
| Ladder | each rung used/skipped/failed combination, mismatch of each authority field stops the ladder, plan binds commits, receipts carry rung outcomes |
| Git runtime | fake `git` binaries for version gates (2.45.0 refused, 2.45.1 accepted); env/flag/global-config contract; askpass ticket host binding; managed install with a local fixture server and wrong-hash rejection |
| Sync | local bare repos: fast-forward with the pin far behind the tip, rewrite (official and managed refuse, custom review), invalid index keeps pin, mirror fallback, a hidden source with installed packages still syncs |
| Network gate | normalization equivalences (scp/ssh/https, case, `.git`), block beats allow, private-network refusal, redirect to a blocked host refused, no auth header across hosts |
| No privileges | a custom package with the same name as a granted plugin gets no grant; a grant fails for a different artifact hash, for a tree-rung install and for a swapped manifest; a legacy entry keeps the grant only with a matching receipt hash; a source's revocation ignores other sources' packages; no package can block its own uninstall; a manifest carrying `installPolicy` is rejected at install |
| Default and required installs | default: installed once through the ladder, never reinstalled after uninstall; required: reinstalled and updated at boot, uninstall and disable denied with `PACKAGE_REQUIRED_BY_POLICY`, becomes a user install when the entry is removed; both lists limited to official/managed sources; migration marks former admin installs as applied and unlocks unmatched entries |
| Identity | reserved names, same `(kind, name)` across sources, `PACKAGE_ID_CONFLICT`, update binding, source switch keeps plugin data |
| Direct install | each detection branch; `server.json` mapping for npm/pypi/oci/remote |
| Service | `former-service.json` parsing, `movedTo` with and without `movedFrom`, reset on build-constant change, policy override, announcements parity, label fallback |
| E2E | packaged dev build (loopback allowed by the dev flag) adds a local-HTTP git marketplace, installs one package of each kind, updates, removes the source |
