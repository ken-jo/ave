# Multi-source Git Marketplace — Design Specification

> Status: **Implemented** (2026-09-25); the public release and the server's
> retirement remain. Where the shipped code differs from this
> page, §13.1 and §16.4 say how. §18 designs the change that follows 0.13.0:
> plain http and local folder sources, address warnings instead of refusals,
> and automatic updates.
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
| **Pin** | The commit SHA a source is currently read at; for a local folder source, its content revision (§18.4.3). |
| **Snapshot** | The parsed, validated catalog of one source at one pin. Immutable. |
| **Install plan** | What the resolver will do for one package version, bound to one snapshot commit: artifact rungs, files, launcher, required consent. |
| **Rung** | One step of the plugin artifact ladder: `release`, `archive`, `tree`. |

## 2. Client state on disk

```
~/.ave/
  installation-id                     # random UUID, local only (rollout bucketing)
  marketplaces/
    sources.json                      # custom and direct sources (§2.1)
    service.json                      # the service move accepted for this build constant (§11)
    service.staging.json              # the same, for a development staging base (§11)
    updates.json                      # the update scheduler's times and classifications (§7.3)
    <sourceId>/
      repo.git/                       # bare partial clone (blob:none); none for a folder source (§7.7)
      snapshots/<pin>.json            # validated snapshots (§2.2), named by commit or folder revision
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
  url?: string;               // a git source: stored in normalized form (§7.1); http with `unencrypted` or a policy listing (§7.4)
  path?: string;              // a folder source instead of `url`: its canonical path (§7.7); exactly one of the two
  ref?: string;               // git only: branch or tag; default = remote HEAD
  subdir?: string;            // git direct sources only: package path inside the repo
  auth: { kind: "none" } | { kind: "token"; host: string } | { kind: "ssh" };   // a folder: { kind: "none" }
  addedAt: string;            // ISO-8601
  label?: string;             // user-visible override of displayName
  acknowledged?: StoredConfirmations;  // confirmations the source holds (§7.4); absent = none
}

interface SourceState {       // marketplaces/<id>/state.json, every origin
  pinnedCommit: string | null;   // 40-hex for a git source, `local-<64 hex>` for a folder (§7.7); null until the first successful sync
  enabled: boolean;              // browsing and installing only (§7.3)
  lastSync?: { at: string; result: "ok" | ErrorCode; candidate?: string };
  pendingRewrite?: { candidate: string; seenAt: string };   // custom/direct awaiting review
  acknowledged?: StoredConfirmations;  // official and managed sources' confirmations (§7.4)
  folder?: { dev: string; ino: string };  // a folder source: the directory's identity when it was added (§7.7)
}

type StoredConfirmations =
  | { url: string; warnings: SourceWarning[] }    // a git source: the normalized address they were given for
  | { path: string; warnings: SourceWarning[] };  // a folder source: the canonical path they were given for
  // another address or path holds none; each warning once

type SourceWarning = "unencrypted" | "token-unencrypted" | "internal-network" | "this-computer" | "internal-downloads" | "network-folder";
```

- A state's pin must fit its source: a folder source holds a folder revision
  and no history rule (`pendingRewrite`, a `lastSync.candidate`), a git
  source a commit and no `folder` identity. A state that does not fit reads
  as `SOURCE_LOCAL_DATA_DAMAGED` `state-invalid`, and the registry refuses
  to write one.

- The official source comes from the build constant `OFFICIAL_MARKETPLACE`
  (`id: "ave"`, primary URL, optional mirror URLs, `auth`). Managed sources
  come from the system policy file (§12). Neither is stored in `sources.json`;
  both keep their state in `state.json`.
- While the design is built, the official repository is private
  (`https://github.com/ken-jo/agent-marketplace`, decided 2026-09-23
  because the `former_org` organization cannot host a new public repository
  or run CI, and renamed from `ave-marketplace-index` on 2026-09-24 when it
  became the monorepo that also holds the official plugins' source, §3.1).
  The constant therefore carries
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
  managed sources only and refuses writes with `SOURCE_LIST_UNREADABLE` until
  the user fixes or deletes the file, so nothing the user added is
  overwritten. Ave never repairs it: the file is the user's data.
- A `state.json` that cannot be read fails that source's sync with
  `SOURCE_LOCAL_DATA_DAMAGED` (§18.8). It is never treated as a fresh,
  unpinned source: a first sync accepts any history. A missing `state.json`
  next to a `repo.git` or `snapshots/` is the same failure; a sync writes the
  state before it creates the repository, so only a lost file looks like that.
  A snapshot at the pin that cannot be read or names another source or commit
  is the same code, and so is a source repository git cannot open (a sync
  records it as `repository-damaged`, never as a network failure). The
  Sources row then offers *Repair*, for every origin. Under the source lock
  it is crash-safe: when the old state still reads, it first writes the pin
  and switch back atomically in place, then renames every other entry of
  `marketplaces/<id>` into a `.trash-<id>-<random>` sibling (a source id never
  starts with a dot), so `state.json` never leaves and a failure or crash at
  any step keeps the pin. Without a readable state the whole directory is
  renamed aside at once. The trash is then walked with `lstat`, never
  following a link; a leftover is swept at the next open or Repair. A failed
  write is `repair-write-failed`, a failed rename `repair-failed` (or
  `repair-failed-unpinned` when there was no pin to keep), and none changes
  what a readable pin says. The sweep never fails an open or a Repair: a
  folder it cannot list is logged and left for later. A source repository
  git cannot open is shown as Repair even while a rewritten history waits
  for review, and accepting that review reports it the same way. Without a readable state the
  source starts unpinned, so the user's Repair is what accepts the history
  served then, and the row's sentence says so before they choose it
  (`state-missing`, `state-invalid`, `state-unreadable`); the snapshot and
  repository reasons keep the pin. Installed packages, tokens, policy and
  `sources.json` live elsewhere and are not touched.

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
  rung: "release" | "archive" | "tree" | "folder" | "legacy";   // "folder": a folder source (§7.7); "legacy": bound by the §16.3 migration, no digest yet
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
- A folder install writes receipt schema v4 with `installSource: "folder"` and
  a `folder` record `{ sourceId, sourceOrigin, revision, packagePath,
  treeSha256, authoritySha256 }`, and the registry `origin` with `rung:
  "folder"`, a `local-` commit and an origin other than `official`. It is
  never a host-secret grant's install (§10.3) and never admits a `process`
  entry (§7.7). Slice F adds the record's `consent` baseline (§18.7.3).

## 3. Marketplace repository layout

### 3.1 Official monorepo

```
marketplace.json                 # index (generated by CI, committed)
plugins/<name>/ave-package.json # release pins
plugins/<name>/source/           # the plugin's source: package.json, plugin.json, src/, test/
mcp/<name>/ave-package.json     # + optional server.json
skills/<name>/                   # ave-package.json, SKILL.md, resources
agents/<name>/                   # ave-package.json, AGENTS.md
themes/<name>/                   # ave-package.json, theme.json
fonts/<name>/                    # ave-package.json, font.json, files/
languages/<name>/                # ave-package.json, language.json, messages.json
providers/<name>/                # ave-package.json, provider.json
messaging/<name>/                # ave-package.json, connection.json
policy/revocations.json          # revocations of this repository's own packages
templates/plugin/                # starting point for a new plugin (not a package)
contract/                        # the plugin contract, vendored from ave (§5.6)
schemas/                         # descriptor and index schemas, vendored from ave
tools/                           # validator, index generator, plugin build helper
package.json                     # workspaces: plugins/*/source, templates/plugin
.github/CODEOWNERS
.github/workflows/               # validate, index, release
```

The official plugins are developed in this repository. Their source sits in
`source/` beside the descriptor, not in the package directory itself, so the
directory has no `plugin.json` and declares no tree rung (§6.2): official
plugins install from release assets only, which is also what a host-secret
grant requires (§10.3). A plugin that is not official, such as the internal
`orion` plugin, lives in its owner's repository and is listed by that owner's
marketplace.

### 3.2 Custom marketplace

Same package directories, including the optional `policy/revocations.json`,
which only ever applies to packages installed from that same source (§10.4).
A plugin directory may also carry a built tree (`plugin.json`, `dist/`,
`assets/`) for the tree rung (§6.2). The `source/`, `templates/`, `contract/`,
`schemas/` and `tools/` directories are how the official repository is built;
the client never reads them.
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
`main` is the publish (D8). The release workflow (§6.3) is the only
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
| `skill` | `{ entry: "SKILL.md" }` | `SKILL.md`, `LICENSE`, `NOTICE`, `scripts/**`, `references/**`, `assets/**` (the Agent Skills layout, agentskills.io) |
| `agent` | `{ entry: "AGENTS.md" }` | `AGENTS.md` |
| `theme` | `{ entry: "theme.json" }` | `theme.json`, optional preview image |
| `font` | `{ entry: "font.json" }` | `font.json`, `files/*.woff2\|woff\|ttf\|otf`, `LICENSE` |
| `language` | `{ locale: string; entry: "language.json"; messages: "messages.json" }` | those two JSON files |
| `provider` | `{ entry: "provider.json" }` | `provider.json`: a preset (today's `MarketplaceProviderPackageAsset` minus `type`), or for a marketplace-eligible built-in vendor `{ providerId, defaultModel?, baseUrl? }` (§5.5) |
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
- `$DATA_DIR`, in arguments and environment, is the package's own data
  directory (`~/.ave/mcp-data/<name>`): created at install, kept across
  updates, and removed at uninstall only when the user chooses to remove
  the data too. A server that keeps state (a database file, an opened
  directory) uses it; `$PLUGIN_DIR` is replaced with every version. A
  remote (HTTP) server naming `$DATA_DIR` is refused: nothing fills it in
  there. Tokens are filled in one pass, and a token ends where a name
  character would continue it (`$NODE_OPTIONS` stays literal).

### 5.3 Plugin manifest changes

For a plugin installed from any git source:

- `extensions["ai.agent-connector.ave"].requires.minAppVersion` is **required** (the
  schema keeps it optional for local development installs) and must equal the
  descriptor's `minAppVersion`.
- Every field of `PluginAuthority` must equal the staged `plugin.json`.

Removed from the manifest schema, `manifest-validation.ts` and their tests in
one change, the switch to the git marketplace; there is no SDK copy to change with it
(§5.6):

- `extensions["ai.agent-connector.ave"].installPolicy` — there are no managed packages
  (§10.1). The install plan (staging and the index CI) rejects a manifest that
  still carries the field, with a message naming it. The runtime loader does
  not: every official plugin installed today carries the field, so an
  installed manifest that has it loads as before, the field is ignored and one
  warning per plugin is logged, until the next update replaces the manifest
  (§16.3). The official plugins drop the field in their first release from
  the official repository; a field-pin version
  (§16.3) keeps it, because it serves existing installs only, and an install
  that resolves to such a version fails with the same named rejection.
- `extensions["ai.agent-connector.ave"].publisher` — under D4 there is no verified
  publishing identity for it to name.

### 5.4 Content validation limits

| Kind | Max total | Max files | Allowed extensions |
|---|---|---|---|
| skill | 2 MB | 64 | `.md .txt .json .yaml .yml .png .jpg .webp`; in `scripts/` also `.py .js .mjs .cjs .sh .pin`; in `assets/` also `.csv .tsv .pdf .hwp .hwpx .docx .xlsx .pptx`; `LICENSE`, `NOTICE` |
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
  activates; a failed activation puts the previous install back. A rollback
  step that fails is logged and never replaces the install's own error. At
  boot every package's files and digest are read again, and a package that
  no longer matches is listed as broken instead of applied. Loading waits
  for any install in progress. Uninstall refuses a `requiredInstalls`
  package (`PACKAGE_REQUIRED_BY_POLICY`). Two paths in one package may not
  differ only in case.
- **Activation and settings.** A settings write that fails undoes the
  install. Once the write has landed, a failed refresh or broadcast is
  logged, not thrown, so settings never describe a package the ledger
  dropped. A first install may not take a provider, vendor or connection id
  the settings already hold from another install path
  (`PACKAGE_ID_CONFLICT`).
- **Theme** — `theme.json` is `{ name, description, shell: "light" |
  "dark", highContrast, tokens, surfaces, preview? }`. `tokens` holds every
  one of the compiled bundles' token names as `"H S% L%"`, `surfaces` the
  surface ladder (`surface-sunken` … `border-strong`). An installed theme is
  held to the same token contract and WCAG contrast rules as the compiled
  bundles (one table, `shared/theme-tokens.ts`). The ids of the bundles that
  stay compiled in (`moonstone`, `gallery`) are refused. The fourteen bundles
  the server marketplace delivers ship as theme packages under their own
  ids, and the switch removes their compiled copies (blueprint 6.2), so a
  selection or a legacy install keeps its name. Until then an installed
  theme wins over the compiled bundle of the same id, and a first install of
  an id the legacy install already turned on is `PACKAGE_ID_CONFLICT`. `preview` must be a
  PNG, JPEG or WebP image by its bytes, at most 2048 px a side. Names and
  descriptions refuse bidirectional overrides and invisible characters. It
  applies as inline custom properties with its shell's shadow stack and
  `color-scheme`.
- **Language** — the locale set is open: any well-formed BCP 47 tag. `en`
  and `ko` stay compiled in; an installed language registers its locale
  with its native and English names, and its messages are layered over
  English, so a key it does not translate reads in English.
  - A package translates the interface only. `messages.json` may use
    English catalog keys outside the model-facing set, which always comes
    from the compiled catalogs: the `be_*` namespace (system prompt, tool and
    reviewer text), the shell execution environment the system prompt
    describes, and a message a surface sends as the user's own
    (`i18n/model-facing.ts`; a static test fails when a key reaches the
    model from outside it). Missing keys are listed, not refused. Any
    other key is refused by the repository check and ignored on a device,
    where it never applies: a package written for another app version names
    keys this one removed or has since made model-facing, and refusing them
    would break every installed language whenever the catalog loses a key.
  - A translation keeps the English placeholder set, and refuses
    bidirectional overrides and invisible characters: an approval prompt
    must ask about what it says.
  - English (`en`, `en-*`) is never installable. A compiled locale is
    installable only under its exact tag (`ko`, not `ko-KR`) and only from
    an official or managed source; it lays its keys over the compiled
    catalog, so removing it keeps that language selected.
  - One package per locale: a second is refused at install
    (`PACKAGE_ID_CONFLICT`).
  - The main process uses installed locales too (dialogs, menus,
    notifications), `<html lang>` follows the active locale, and an
    announcement label falls back to English for a locale it does not carry.
- **Font** — `font.json` is `{ family, license, faces: [{ file, weight,
  style }] }`, with a `LICENSE` file required; a face's format comes from
  its extension and its bytes must match it, and a weight range is
  ordered. The renderer declares the faces under `ave-font-<package name>`
  with `ave-content:` URLs only; `family` is the picker's label. A package
  therefore cannot shadow a system font or another package's family. One
  package per family: a second is refused at install. The font-family
  setting holds up to 256 characters, room for the longest installed stack.
- **Provider and messaging connection** go through today's normalizers,
  with no field dropped or rewritten, and take effect through the settings
  paths today's asset install uses. A provider package whose `providerId`
  is a marketplace-eligible built-in vendor is `{ providerId,
  defaultModel?, baseUrl? }`: it unlocks that vendor
  (`marketplace.installedProviderIds`) and may set its default model. Only
  an official or managed source may set its `baseUrl`, which must be
  https, because the vendor's key goes wherever it points; moving it drops
  the key saved for the old address, as a preset's base URL change does
  (if the settings write fails, the key comes back and the
  settings stay on the old address). Uninstalling the
  package locks the vendor again and drops its key, which may have been
  entered for the package's address.
- **Selection stays the user's.** Installing does not select a theme,
  language or font. Removing the selected one puts that setting back to its
  default; a selected id that is not installed renders the default.
- **Asset scheme.** `ave-content://<token>/<kind>/<name>/<path>` answers only the
  files the loaded store lists (font faces, theme previews), with `nosniff`;
  anything else is 404. The CSP admits it for `img-src` and `font-src` only.
  Web pages the app opens share the default session and can send requests
  with no origin or referrer, so the host of every URL is a random token
  drawn at launch that only the app's renderer receives; a URL without it
  is 404, and a page cannot name, probe or read an installed file. The
  answer also admits only the opaque origin of the app's `file:` windows
  (`Access-Control-Allow-Origin: null`) and refuses an http(s) origin or
  referrer.
  Its handler is registered with the IPC handlers, before the main window
  loads, because a frame binds its custom-scheme loaders when it commits.
- **Loading.** The store loads on the renderer's first request at boot (or
  the first asset request), not while IPC is registered, so a process that
  never asks reads nothing under `packages/`.
- Install and uninstall IPC arrive with the install surface (§13); until
  then two read-only channels expose installed content.
- **Coexistence until 6.2.** The legacy marketplace settings
  (`installedThemeBundleIds`, `installedLanguagePacks`, the asset-install
  vendor and preset path) keep working next to the ledger until blueprint
  6.2 migrates them (§16.2); the id-conflict rule above keeps the two from
  claiming the same id.
- **Snapshot retention.** `contentLedgerOrigins` is the ledger's
  `retainedCommits` source; the syncer is wired to it together with the
  install IPC in blueprint 6.1.

### 5.6 Plugin contract for authors

A code plugin compiles against two ave files:

- `src/plugins/public-contract.ts`: the types, the runtime ABI constants,
  `flattenAgentPluginsManifest` and the storage error class.
- `schemas/plugin-manifest.schema.json`.

Neither file imports anything. There is no separate SDK package. The
`ave-plugin-sdk` repository mirrored these two files under a version number
of its own. Mapping an SDK tag to the app releases that implement it was a
second numbering of the same contract, and nothing checked it. The repository
is retired with the server, after the first public release.

- **Vendoring.** A plugin repository copies both files, unchanged, into
  `contract/` at an ave release tag. That may be the official monorepo or
  any other repository, such as the one holding the internal `orion` plugin.
  `contract/sources.json` records the repository, the tag and each file's
  sha256. Plugin code imports the copy as a workspace package,
  `@ave/plugin-contract`.
- **Two checks.** This is the pair the host already uses for its schema
  snapshots:
  - The offline check runs in every CI. It fails when the committed bytes no
    longer hash to `sources.json`, meaning someone edited the copy.
  - The networked check fails when the file at the recorded tag does not have
    those bytes. It runs on pull requests that touch `contract/` and daily,
    and it also reports when a newer app release changed the contract.
  - To refresh the copy, run the sync script with a new tag. Never edit the
    copy.
- **The contract version is the app version.** A plugin that uses a member
  first shipped in release X sets `requires.minAppVersion` to X or later. The
  host already enforces `minAppVersion` at install and load, and a git
  install requires it (§5.3). So a plugin built against a newer contract never
  loads on an app that lacks it.
- **At run time.** The build bundles everything a plugin imports at run time
  into its own `dist/`, except `HOST_EXTERNAL_MODULES`. An installed plugin
  therefore never depends on the contract package, and the host validates the
  manifest at install and load as before.
- **Build helper.** `defineAvePluginConfig`, the SDK's tsup preset, moves to
  the official repository's `tools/`. It reads `HOST_EXTERNAL_MODULES` and
  `BUNDLE_EVERYTHING_REGEX` from the vendored contract. Other repositories
  copy it or write their own; it holds no contract of its own.
- **Package schemas.** For marketplace delivery, the descriptor (§5.1–5.2)
  replaces the SDK's skill and agent package schemas. The host still needs
  one of them: the SKILL.md front-matter definition it implements.
  - The definition moved from `schemas/sdk/skill-package.schema.json`, a
    snapshot of the retired repository's file, to the host-owned
    `schemas/skill-package.schema.json`.
  - The snapshot gates were removed in blueprint 6.3: `check:sdk-schemas`,
    `check:sdk-schemas:verify` and `sdk-schema-drift.yml`.
- **Interim, not the end state.** Code plugins stay in the host process. There,
  compile-time types are the only early check on the HostApi they call.
  Moving plugins out of process is a separate design,
  `docs/design/plugin-hostapi-protocol.md`: the HostApi becomes a versioned
  protocol, and a published protocol schema replaces the vendored types.

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

This is the ladder of a git source. A folder source's plugin has one rung,
`folder`, and never downloads (§7.7).

```
plan = { snapshotCommit, versionCommit, rungs: [] }        // fixed at plan time
for rung in [release, archive, tree]:
  if rung not declared                               -> skip(rung, NOT_DECLARED)
  if rung in {release, archive} and no sha256 pin    -> skip(rung, ARTIFACT_NOT_PINNED)
  fetch rung                                          // every URL passes §7.4 first
    release: https GET (token only to the origin host; auth headers stripped on cross-host redirects;
             a private asset is fetched with the token only through the GitHub REST asset API
             on github.com; elsewhere the rung runs without it and a private asset falls to the next rung)
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

The official plugins are built in the official repository (§3.1), so one
repository holds the source, the release assets and the pins.

1. A pull request changes `plugins/<name>/source/` and raises the version in
   its `plugin.json` and `package.json` together. CI builds and tests the
   plugin, and validation fails if the two versions differ or if the new
   version does not exceed every version already in the descriptor.
2. After the merge, the release workflow runs on `main`. For each plugin
   whose source version has no tag `<name>-v<X.Y.Z>` yet, it builds
   `{name}-{X.Y.Z}.zip` from the merge commit. It then creates that tag and
   a release carrying the zip as its asset. A tag that already exists is never
   rebuilt or re-uploaded.
3. The same workflow opens a pin pull request against
   `plugins/<name>/ave-package.json`. From the uploaded asset, it sets
   `version`, `minAppVersion`, `authority` and `artifact.release`: `repo` is
   this repository, plus `tag`, `asset` and `sha256`.
4. CI on the pin PR downloads the asset, verifies its hash, unpacks it, checks
   `plugin.json` against the descriptor, and regenerates the index.
5. Merge = publish.

The source change and the pin are separate merges. Building and testing a
version does not publish it.

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
- `http://` is accepted here. The gate decides whether it needs a
  confirmation or is blocked by policy (§7.4).
- rejected with `SOURCE_URL_REJECTED` and a reason (§14), before any traffic:
  - a `<helper>::` transport (`ext::`, `fd::`, `hg::https://…`):
    `helper-transport`. `ext::` runs its text as a command, and any other
    helper runs `git-remote-<helper>` from the search path (§18.3 #1);
  - credentials in the URL (`https://user:secret@…`, `https://token@…`):
    `credentials-in-url`. An ssh user name (`git@`) is not a credential
    (§18.3 #2);
  - any other scheme (`git:`, …): `scheme-unsupported`;
  - a query, fragment, whitespace, control character or backslash:
    `format`; dot and empty path segments.

  A `file:` URL or a path never reaches this function: `normalizeSourceInput`
  (`src/marketplace/net/source-input.ts`) sends it to the folder stages of
  §7.7, and keeps `owner/repo` the GitHub shorthand.

Policy allow/block matching (§12), reserved-name checks, token lookup and
duplicate detection all use the normalized form. Repository identity in those
comparisons is the host plus the path compared without case, on any scheme and
port (§12).

### 7.2 Add (preview → confirm)

1. **Normalize** the input (§7.1) and apply the gate's refusals and the
   managed policy (§7.4). A refusal or a policy block ends the preview.
2. **Confirm before any traffic.** Some warnings are known from the address
   alone: plain `http`, the class of a literal address, and token sign-in over
   http (`token-unencrypted`). If the request's `acknowledge` lacks one, the
   preview answers `{ type: "confirm", warnings }`. It runs no lookup and no
   git command first.
   The runner's preflight then resolves the host once (for an ssh remote,
   the ssh preflight of §7.4). A class that needs a confirmation answers
   `confirm` the same way, before any git command. The dialog's *Continue*
   previews again with those warnings added to `acknowledge`.
3. **Fetch** the ref into a temporary bare repo and read the root.
   - An auth failure returns `SOURCE_AUTH_REQUIRED`, and the dialog asks for a
     token. Over http without `token-unencrypted`, no credential is offered,
     and the host's 401 answers `confirm` with `token-unencrypted` instead.
   - An unknown SSH host key returns `SOURCE_SSH_HOST_UNKNOWN`.
   - A missing ref returns `SOURCE_REF_NOT_FOUND`.
4. **Classify**: marketplace (index or conventional layout) → preview; single
   package (descriptor, `plugin.json`, `SKILL.md`, `AGENTS.md`, `server.json`
   at the root or the given subdir) → direct-install preview; otherwise
   `SOURCE_NOT_A_MARKETPLACE`.
5. **Preview** returns:
   - a `previewId` (single use, expires after 10 minutes; the temporary repo
     is deleted on expiry or cancel);
   - the resolved commit, marketplace name and owner;
   - package counts per kind, and how many packages execute code (plugins +
     MCP);
   - validation diagnostics;
   - `badges`: what the source will show once added (`unencrypted` for http,
     and each address class confirmed).
6. **Confirm** writes the entry with exactly the confirmations the preview
   carried (`acknowledged`), writes the source's `state.json`, then moves the
   temporary repo into place and publishes the snapshot. A `repo.git` without
   a state is read as lost state (§2.1). The add checks the policy again: one
   changed since the preview applies.
   - The id defaults to the index `name`.
   - A reserved or taken id (`SOURCE_ID_TAKEN`) makes the dialog ask for
     another. A folder overlapping a folder source is `SOURCE_ID_TAKEN` with
     a `folder-*` reason instead (§7.7), whose sentence names that source:
     another id cannot resolve it.
   - A malformed id is `SOURCE_ID_INVALID`.

### 7.3 Sync

A sync of every source is a **discovery**: it enforces the revocations it
brought (§10.4) and computes the updates of the installed packages. It runs
at boot, after the revocations already on disk are enforced and before the
default and required installs (§10.2), when it is due, and on *Check now*; a
source's own *Refresh* syncs that source only. One scheduler
(`src/marketplace/app/background.ts`) runs a **due check** at most an hour
apart, on `powerMonitor` `resume`, after a write of `marketplace` settings,
and on *Check now* (`ave:marketplace:updates:check`):

- **Discovery is due** after a failed attempt (`partial`, `offline` or
  `error`) once `lastAttemptAt` is an hour old, whatever `lastSuccessAt`
  says, and after a success once `lastSuccessAt` is
  `marketplace.updateCheckIntervalMs` old. The setting keeps its key: unset
  is 6 hours, a stored value below 15 minutes reads as 15 minutes, and `0`
  leaves discovery to boot, *Check now*, the hourly retry after a failure,
  and the apply check. It is optional and unset by default, so no stored
  value needs migrating.
- **The apply check is due** at boot, on *Check now*, and 24 hours after the
  last successful one; a failed discovery holds it to the same hourly retry.
  It always obtains a fresh discovery — it joins one in flight, or starts
  one — and classifies only that discovery's updates: all of them when the
  result is `ok`, and then `applyCheckAt` is written when the check ends;
  those of the reached sources when `partial`; none when `offline` or
  `error`. This build
  classifies every update `manual`: nothing applies by itself until
  automatic apply (§18.7.2–§18.7.4) is built, so each update waits for its
  review (§15.6).
- **A discovery's result** is `ok` when every source synced, `offline` when
  every source failed `SOURCE_UNREACHABLE` reason `offline`, `partial`
  otherwise, and `error` when the pass threw. A broken source (§18.8) is not
  synced and is not offline: it counts as not reached, so a discovery with
  one is `partial`, whose card leads to the Sources view. Its times, and
  `applyCheckAt`, are taken when the pass ends, so a slow failure is not
  retried the moment it ends, and a check that spans a sleep is not due
  again the moment it ends.
- **What is published** follows the sources the last discovery reached. An
  update from a source it reached is classified; one from a source it did
  not reach comes from that source's cached snapshot and is never classified
  anew: it shows only as an earlier discovery showed it, marked `stale`,
  while the package still offers that version, and not at all otherwise. A
  discovery that throws reached no source: everything shown turns `stale`
  the same way, and no version cached since is classified until a
  discovery reaches its source.
- **A stopped scheduler** (`stop()` at quit) does nothing more. One
  lifecycle gate carries every outward effect: the four publications
  (`publishStatus`, `publishNotice`, `publishUpdates`,
  `publishUpdateStatus`); every call that reads or changes state outside
  the scheduler (opening the service, `enforceRevocations`, `discover`,
  `takeRevocationNotice`, `updates`, `applyBootInstalls`, reading the
  applied defaults, loading `updates.json`); every write of `updates.json`,
  the replacement of an unreadable file included, which the loader reports
  and the scheduler writes; and the due-check timer. After a stop the gate
  drops publications and refuses work, and work in flight ends in a stop
  whether it fulfils or rejects, so no continuation publishes, writes, logs
  or starts anything. The service receives the gate's shutdown signal with
  `discover`, `enforceRevocations` and `applyBootInstalls`: once it aborts,
  no further stage starts (a sync, an enforcement, the boot installs'
  catalog, the next boot install, an enforcement still queued behind
  another) and no sync progress is sent, while a stage already started
  finishes. Whatever an internal continuation still sends is stopped at one
  boundary: the IPC domain builds the service, the syncer and the
  revocation sink with `marketplaceEvents`, which passes each of their
  outward callbacks — `onSyncProgress`, `onInstallProgress`, and
  `onCatalogChanged` of the service, the syncer and the sink — and the
  scheduler's four publications through `whileRunning` over the
  marketplace's lifetime (`getMarketplaceLifetime`, shared by the domain,
  the git runtime and deep links). Its plugin port announces a landed
  install (`plugin.installed` to the host's subscribers, the plugin bridge
  refresh) through the same boundary, the git runtime's install progress
  (`git-runtime:progress`) passes it too, and a marketplace deep link is
  refused once it has ended, before anything is held, opened or sent. One
  shutdown hook (`git-marketplace-events`, registered with the domain)
  aborts that lifetime and stops the scheduler in the same step; a sync, an
  install and their records still finish, but nothing they send reaches the
  renderer or the host's subscribers. The loader of `updates.json` neither writes nor
  logs; it returns why it reset, and the scheduler says so through the gate.
  *Retry* (`ave:bootstrap:retry`) and *Check now* answer with their
  declared refusals.

The scheduler keeps its times in `~/.ave/marketplaces/updates.json`, so the
cadence survives a restart and a sleep: the timer only wakes the due check,
which reads the wall clock. The timer is unreferenced, re-armed after every
check, and cleared on quit; a stopped scheduler starts nothing.

```
{ version: 1,
  discovery: { lastAttemptAt, lastSuccessAt, result: "ok" | "partial" | "offline" | "error" } | null,
  applyCheckAt: string | null,
  packages: { "<sourceId>:<kind>:<name>": { to, state, attempts, lastError?: { code, detail?, at }, appliedAt? } } }
```

The file is read strictly: duplicate or unknown keys, another version, a
time that does not parse, or a state outside §18.7.5's eight refuse it. One
that cannot be read is replaced by an empty one and the Updates card says so
(`historyReset`, §15.7.1); that moves only check times, never what applies. A
`lastError.detail` whose reason does not belong to its code is dropped and
the code kept, as in `state.json` (§14).

The settings `marketplace.autoUpdate` (boolean, unset = on),
`marketplace.autoUpdateSources` (keyed by source id) and
`marketplace.autoUpdatePackages` (keyed by `packageUpdateSkipKey`, normalized
like `skippedPluginUpdates`), each value `"on"` or `"off"`, are normalized
when read: an invalid key or value is dropped, and both maps have no
prototype. They decide nothing until automatic apply (§18.7.2).

A source syncs while it is enabled **or** while any installed package is
bound to it, so revocations and update notices keep reaching installed
packages from a hidden source.

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

One gate (`src/marketplace/net/network-gate.ts`) checks every git remote,
release and archive URL, and the managed git archive. The service endpoint
keeps its own rules (§11).

1. **Normalize** (§7.1). `https` and `http` downloads follow the same
   host/port/path rules: canonical percent-encoding, and an empty, `.` or
   `..` segment is refused.
2. **Managed policy** (§12): `marketplaces.block`, then `marketplaces.allow`
   (when present), then `requireHttps`.
   - For a download, an exact repository pattern also covers every path
     beneath the repository (`…/acme/tools/releases/download/…`).
   - For a git remote it names that repository only, since a nested path is
     another repository on hosts with subgroups.
   - An unreadable policy blocks every target except the official source's.
3. **Address class.** `classifyAddress` (`src/core/network-guard.ts`)
   classifies a literal address, or each answer of the one lookup of
   step 4:

   | Class | Addresses |
   |---|---|
   | `public` | globally routable |
   | `internal` | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `100.64.0.0/10`, and `198.18.0.0/15` (fake-IP proxy tools answer every name from this block), minus the metadata addresses |
   | `this-computer` | `127.0.0.0/8`, `0.0.0.0/8`, `::1`, `::` |
   | `metadata` | `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `100.100.100.200` |
   | `unroutable` | every other special-purpose block (documentation, multicast, reserved, broadcast, protocol assignments) |

   IPv4-mapped IPv6 and NAT64 (`64:ff9b::/96`) addresses take the class of
   the IPv4 address they embed. The outcome then depends on who chose the
   target:

   - **Entered targets**: the address the user typed, the official build
     constant, and a managed policy entry.
     - `public` over https or ssh is accepted.
     - `internal`, `this-computer` and plain `http` each need a confirmation
       the source holds: `internal-network`, `this-computer` or `unencrypted`.
       Without it the call fails `SOURCE_CONFIRMATION_REQUIRED`.
     - A host the policy lists (`allowHttpHosts`, an `allow` pattern, an
       `additional` source) needs none of the three.
     - An unpackaged build started with `AVE_DEV=1` needs no confirmation
       for `this-computer`, nor for http to a loopback literal or
       `localhost`.
   - **Catalog-supplied targets**: release and archive URLs, the derived
     release URL of §6.2, and every redirect hop of a download.
     - `public` is accepted over https and over http. Over http the
       Delivery row says the download is unencrypted and verified by its
       pinned sha256; a rung without a pin is skipped (§6.2).
     - The source's own host inherits the source's confirmations. For
       `this-computer` it must also be on the same port. An ssh source's
       derived `https://<host>` counts as https on port 443.
     - Another `this-computer` host or port is refused
       (`catalog-this-computer`, §18.3 #4). This hard refusal comes before
       every exemption: a policy that lists `127.0.0.1` for one source does
       not let another catalog reach other services on this computer.
     - Another `internal` host is accepted when the policy lists it, and
       otherwise needs `internal-downloads`, which `internal-network` does not
       imply.
     - A download no source names (`catalog: null`) cannot hold a
       confirmation, so plain http, or a hop to an internal address, fails
       `SOURCE_CONFIRMATION_REQUIRED`.
   - **Every target**:
     - `metadata` and `unroutable` addresses are refused, policy-listed
       hosts included (`address-metadata`, `address-unroutable`, §18.3 #3).
     - `blockPrivateNetworks` makes `internal` and `this-computer` a policy
       block (`private-network-blocked`), except for a policy-listed host.
     - `requireHttps` makes plain http a policy block (`https-required`),
       except for `allowHttpHosts`.
     - No confirmation passes a policy block.

4. **The check is bound to the connection.** The gate itself does not
   resolve names. It hands an address policy to the transport, which
   resolves the host once and connects only to answers that pass.
   - **Downloads** go through the pinned transport
     (`src/marketplace/net/pinned-fetch.ts`, through
     `fetchAddressCheckedResponse`):
     - Each hop makes one `dns.lookup(host, { all: true, verbatim: true })`.
     - Refused and blocked answers are dropped. The transport connects to a
       remaining answer by address, with TLS `servername` set to the host
       name.
     - If no answer is left, the hop fails with the refusal of the most
       restrictive dropped class: metadata, unroutable, this-computer, then
       internal.
     - An answer that needs a confirmation the source lacks fails the hop.
     - The trust store is Node's default CAs plus the system store, and
       every TLS connection sets certificate verification itself, so an
       inherited process-wide override that disables certificate
       verification does not turn it off.
     - The route is the first entry of the session's `resolveProxy(url)`,
       never a silent fallback to `DIRECT`:

       | PAC kind | What the transport does |
       |---|---|
       | `DIRECT` | connects to the checked answer |
       | `PROXY` | sends an absolute-form request for http, `CONNECT` for https |
       | `HTTPS` | opens TLS to the proxy, then works as `PROXY` |
       | `SOCKS5` | uses the domain-name address type |
       | `SOCKS` / `SOCKS4` | sends the target's checked IPv4 answer |

     - The proxy's own address is checked: `metadata` and `unroutable` are
       refused, and anything else is accepted, because the system
       configuration chose it. A literal proxy address is its own one
       answer, judged the same way (IPv4-mapped and NAT64 forms included).
     - Any other PAC kind fails `SOURCE_UNREACHABLE` reason `proxy`.
     - Beyond a proxy that resolves the target itself, the proxy is trusted.
       `trusted-proxy.test.ts` pins that boundary.
   - **git over http(s)**:
     - Each call asks the PAC resolver once. git is configured with that
       route (`http.proxy`), and the binding checks the same route, so a PAC
       answer that changes between two questions cannot leave git on an
       unchecked proxy.
     - Each call resolves the host once and passes
       `-c http.curloptResolve=<host>:<port>:<address>[,…]` with the answers
       that remain.
     - A proxy host is checked as for downloads and pinned the same way; a
       literal proxy address is checked as its own one answer.
     - A call whose answers are all refused starts no git.
   - **git over ssh: a preflight check only.**
     - `ssh -G [-p <port>] <user>@<host>`, run with the git call's
       environment, prints the effective configuration.
     - The printed `hostname` is resolved once. Any refused or blocked
       answer refuses the call, because ssh may connect to any of them. A
       class that needs a confirmation fails `SOURCE_CONFIRMATION_REQUIRED`.
     - When `proxycommand` or `proxyjump` is set, the runner does not
       resolve the target.
     - ssh still runs as `ssh -o BatchMode=yes`, with no host pin.
     - Residual: an answer that changes between the preflight and ssh's own
       lookup is not bound. The host key is the trust anchor (§18.2.4).
5. **Redirects.**
   - git never follows them (`http.followRedirects=false`).
   - A download follows a redirect only after steps 1–4 pass for the new
     URL. It never carries `Authorization` or `Cookie` to a different
     origin.

**Credentials over http.** A source over plain http answers sign-in only
when it holds `token-unencrypted`. No policy listing implies that
confirmation.

- Without it, askpass issues no ticket for the call, and every git call
  carries `-c credential.helper=`. Neither a stored token nor an OS helper's
  password is sent in the clear, and the preview does not show its note that
  a credential helper answers for the host.
- The resulting auth failure is `SOURCE_AUTH_REQUIRED` reason
  `token-unencrypted`, and the Sources row offers *Allow…* for it.
- `GIT_ALLOW_PROTOCOL` names `http` only for an http remote that passed the
  gate.

**Confirmations** are per class, never per resolved address. Each source
stores its own `acknowledged` record (§2.1): in `SourceEntry` for custom and
direct sources, in `SourceState` for official and managed ones. The record
names the normalized source address (scheme, user, host, port and path) the
confirmations were given for. A source whose address is another one holds
none: a managed entry the administrator points elsewhere, or a hand-edited
`sources.json`, never carries consent to the new service, also across a
restart. A new *Allow…* replaces the old record.

- A target can later need one the source lacks: a name now resolves to an
  internal address, or a catalog names another internal host. The sync, plan
  or install then fails `SOURCE_CONFIRMATION_REQUIRED`.
- `sources:acknowledge` adds the confirmation and syncs again.
- To withdraw one, remove the source and add it again.

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

### 7.7 Local folders

A folder is a marketplace (its root holds `marketplace.2.json` or the
conventional layout of §3.3) or one package (a direct source, §8). It is
typed where an address is — *Add marketplace…* and *Install from Git URL or
folder…* — or chosen with *Choose folder…* (`sources:pick-folder`, main's
folder dialog), and goes through `sources:preview` and `sources:add` like
any address (§13.1). How it looks is §15.2, §15.4 and §15.5. The design and
its reasoning are §18.4; this section is what is built.

**Input** — `normalizeSourceInput(input, platform, home)` and the preview
(`MarketplaceService.previewFolder`) run four stages. Stages 1–3 make no
call on the path: a block or a confirmation ends the preview before a share
is contacted.

1. **Lexical parse.** A `file:` URL, and input starting with `/`, `~`, a
   drive (`C:\`, `C:/`), `\\` or `//`, is a folder; anything else is a git
   address (§7.1). `~` expands to the home directory the service is given.
   `\\?\C:\…` and `\\?\UNC\server\share\…` lose their prefix, `.` and `..`
   segments are applied lexically. Refused with `SOURCE_URL_REJECTED`, each
   with what to enter instead: a relative path (`./x`, `C:foo`, `~user`,
   `relative-path`), a Windows device path (`device-path`), a drive or UNC
   path on macOS or Linux (`windows-path`), a `file:` URL naming another
   computer there (`network-file-url`), a UNC path without its share
   (`unc-without-share`), a UNC server spelled with an account
   (`\\user:secret@server\share`, `unc-credentials`: credentials never
   belong in a folder path; WebDAV's `server@SSL` and `server@8080` are not
   accounts and stay), a `..` above the drive, share or `/`
   (`outside-root`), and a branch, subfolder or sign-in given with a folder
   (`folder-options`).
2. **Network classification.** A UNC path is on another computer. A Windows
   drive letter is classified by its current mapping, which the helper
   `ave-path-kind.exe` (`native/windows-path-kind/`, launched by
   `src/main/windows-path-kind-launcher.ts`) reads with `QueryDosDeviceW`: a
   volume, CD-ROM or floppy is local, a `subst` drive is its target's drive
   (followed a bounded number of times), and anything else — a redirector,
   an unknown device, a drive the OS has no mapping for (the helper's exit
   1) — is a network folder, with the server when the mapping names one. A
   helper that is missing, cannot start, times out, or answers outside its
   protocol is a broken install, not an answer about the drive: the input
   fails with `SOURCE_LOCAL_UNREADABLE` `classifier-unavailable`, whose
   sentence says to reinstall Ave; the helper's own words stay in the
   diagnostic message. On macOS `/Network/…` and on
   both macOS and Linux `/net/<host>/…` are automount paths and network,
   compared ignoring case on macOS (its volumes ignore case by default, so
   `/network/…` reaches `/Network/…`); `/` is network too, since reading it
   reaches them. Any other path is local: a mounted share was authenticated
   when it was mounted.
3. **Policy, then consent.** `allowLocalSources` and the `path:` patterns
   (§12) are applied to the lexical path first, so a blocked folder costs no
   call at all, not even the drive's mapping. A network folder then needs
   `network-folder`; without it the preview answers `{ type: "confirm" }`
   and the dialog asks.
4. **Resolution.** The path is walked component by component through
   `FolderFs` (`lstat`, `readdir`, `readlink`; it has no `realpath`). Each
   component takes its on-disk spelling — on Windows an 8.3 short name
   (`PROGRA~1`) takes the long name of the entry with the same `dev` and
   `ino` — and a link in the entered path is
   followed by its text: a text that names a network location, or that
   resolves against the link's directory to one (relative text such as
   `Network/Servers/…` from `/`), is refused as `CONTENT_RULE_VIOLATION`
   `link-to-network` before anything touches it. Every call of the walk, and
   of the reading after it, goes through a fence (`fenceFolderFs`) that
   classifies the path first: without `network-folder`, a path on another
   computer — a spelling recovered from disk, a component after a local
   link — answers `confirm` instead of being touched. The policy and the
   network classification are applied again to the canonical path. The
   preview carries the canonical `path`, and `resolvedFrom` (what was typed)
   when they differ.

**Reading** (`FolderTree`, `src/marketplace/sources/folder-tree.ts`; the
rules are §18.4.5). Inside the folder a link is judged by its text before
any call touches its target: one that leaves the folder is
`link-outside-folder`, one naming another computer, or resolving onto a
network location other than its own, `link-to-network`, a loop or too many
links `limit`; one that stays inside is read as a regular file holding its
target's bytes. Each component a path names takes the spelling its parent
lists, the entry with the same identity when the spelling differs (case, an
8.3 or trailing-dot alias); a link whose target passes through a skipped
entry is `link-to-skipped`, and a path naming one finds nothing. A hard
link is a regular file and is read like one. A file is opened without following a final
link, its `fstat` must be the file `lstat` saw, and after each read the
chain of directories from the root is checked again; a difference is
`SOURCE_LOCAL_UNREADABLE` `changed-during-read`. A swap that is undone
before that check is the stated residual of §18.4.5. `.git/`, `.DS_Store`,
`._*`, `Thumbs.db` and `desktop.ini` are skipped unread; names are NFC, and
two names equal after NFC or ignoring case are `case-collision`; a device, socket or FIFO is `special-file`;
the executable bit is kept. No git command ever runs against a folder, and
git's `file` transport stays `never` (§18.3 #5 and #6).

**Revision and sync.** A folder's pin is its revision: `local-` and the
sha256 over the files the snapshot read and one tree digest (§6.4) per
package, so editing any file a package installs changes it. The snapshot is
`snapshots/<revision>.json`. A read has no history rule, and only the
version whose files are in the folder is offered. Every read — the
background sync, a refresh, a plan — repeats stages 2–4 on the stored path:
a policy now blocking it, or a network folder without its confirmation,
fails the same way an add would. A stored path whose walk ends at another
directory, or whose `dev`/`ino` changed since it was added, fails
`SOURCE_LOCAL_UNREADABLE` `moved`, and the new target is not read. Any
failure keeps the last good snapshot; its reason is stored in
`lastSync.detail` like any sync's (§14) and the Sources row says it after a
restart.

**Identity.** Two folders are one source when their canonical paths are
equal byte for byte or their directories report the same non-zero `dev`
and `ino`; nothing is folded by platform, so a case-sensitive volume keeps
`/Approved/Tools` and `/approved/tools` as two. A folder that is a source,
or contains or lies inside one, is refused with `SOURCE_ID_TAKEN`: by path,
and by the identities stage 4 records (the folder's and every directory's
above it, kept in `state.json` at each read), so an alias of a source or of
its ancestor — another drive letter, a share, a firmlink — is caught too.
Confirmations are bound to the canonical path (§2.1).

**Plan and install.** A plan reads the folder again (publishing a new
snapshot when it changed) and copies the package into a capture under the
work directory; the capture's digest must equal the snapshot's, or the plan
fails `changed-during-read`. Execution installs only the capture, which is
deleted when the plan executes, is replaced or expires. An edit made after
the review therefore never reaches the install, and §18.8's `PLAN_EXPIRED`
`folder-changed` has no case that raises it. For a plugin the ladder has one
rung, `folder`: `plugin.json`, `dist/**` and `assets/**`. Declared release
and archive rungs are not tried and nothing is downloaded. Other top-level
entries (`src/`, `package.json`, `node_modules/`; the descriptor excepted)
are left out and listed in the plan's `notInstalled`. A folder with no
`plugin.json` fails `NO_INSTALLABLE_ARTIFACT` `folder-has-no-build`, and a
`process` entry is refused with `process-entry-requires-pinned-artifact` at
the rung and again by the installer (§18.4.9). Skills, agent plugins and MCP
servers install from the capture the same way.

**Direct folders.** A folder that is one package is a direct source. Its
version is the descriptor's, or `0.0.0+t<digest12>` from its tree digest
(§8.2). A reading rule its files break fails the preview with that reason,
where a marketplace drops the one package with a diagnostic (§2.2). `allowDirectInstall: false` refuses it at the preview, the add and
the plan (§12).

**Show in Finder.** `sources:reveal` takes a source id, never a path, and
answers only for a folder source (a git source or an unknown id is
`invalid-request` or `SOURCE_ID_INVALID`). Before main asks the shell to
show the folder, the stored path is judged exactly as a read judges it (one
function, `openStoredFolder`): the policy, the drive's current mapping and
the source's confirmations, then the fenced walk, the same canonical path
and the recorded `dev`/`ino`. A drive that now maps to a share the source
never confirmed is `SOURCE_CONFIRMATION_REQUIRED` `network-folder` with
nothing on the share touched. A path that now leads to another folder, or a
directory recreated at the same path, is `SOURCE_LOCAL_UNREADABLE` `moved`,
as a refresh says. A drive whose folder classifier cannot run is
`SOURCE_LOCAL_UNREADABLE` `classifier-unavailable` ("… Reinstall Ave.")
with nothing shown. A folder that is gone is `not-found` rather than a
silent no-op. The last step classifies the path again and checks the
confirmation. Main then hands the path to the shell with no filesystem call
in between.

**Reveal boundary.** The shell takes a path string, not a handle. What it
opens is whatever the path means when it acts. A drive remapped to a share
after that last classification, by a concurrent change on this computer,
can therefore be shown without `network-folder`. Like the concurrent
replacement boundary of §18.4.5, this residual needs a concurrent local
change. It is narrowed to the gap between one classification and one shell
call, and it is stated, not defended.

**Badges.** A folder source and its package cards carry one badge by the
path's stage 2 class: *Local folder* (`local-folder`) or *Network folder*
(`network-folder`). A path now on another computer that the source does not
hold `network-folder` for carries *Network folder, not allowed*
(`network-folder-unconfirmed`). Its tooltip says Ave does not read it until
it is allowed, and never claims a consent the source lacks. A folder whose
classifier cannot run carries *Location unknown* (`folder-unclassified`),
with the reinstall sentence. Only that row and its cards are affected: the
listing, the other rows and every recovery control still show. The class is
computed in main and kept for a minute per path, so a listing does not query
a drive's mapping once per row. A failure is not kept. A preview classifies
its canonical path fresh, without that cache, and is badged only after the
confirmations it needs.

## 8. Direct install (no marketplace manifest)

### 8.1 Inputs

| Input | Detection | Result |
|---|---|---|
| Git URL (+ optional subdir, ref) | first match at the path: `ave-package.json` → `plugin.json` (Agent Plugins) → `SKILL.md` → `AGENTS.md` → `server.json` | a `direct` source entry for that package |
| Folder path (§7.7) | the same order, at the folder's root | a `direct` folder source for that package |
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
  `0.0.0+g<commit12>` in a git source and `0.0.0+t<digest12>` (the package's
  tree digest, §6.4) in a folder; `minAppVersion` defaults to `0.0.0` for
  these non-executing kinds.
- `server.json` → `version` from the file; `minAppVersion` `0.0.0`.

A direct package updates when its ref moves to a descendant commit that
declares a higher version (or any new commit for synthesized `0.0.0+g…`
versions), after the same update review as marketplace packages. A direct
folder offers an update whenever its files change a synthesized version.

`allowDirectInstall: false` (§12) refuses a direct source, git or folder,
at the preview once the input is found to be one package, at the add, and
at every plan from a direct source added before it.

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
The one exception is the version probe (`git --version`, §9.1), which runs
before a runtime is chosen: no repository, no network, and the same reduced
environment.

Environment (both modes):

- `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=<Ave-generated file>` (below), `LC_ALL=C`.
- `GIT_ASKPASS=<Ave askpass helper>`, `SSH_ASKPASS_REQUIRE=never`,
  `GIT_SSH_COMMAND="ssh -o BatchMode=yes"` (an unknown host key fails fast
  with `SOURCE_SSH_HOST_UNKNOWN` instead of waiting for a prompt).
- `GIT_ALLOW_PROTOCOL=https:ssh`, plus `http` only for an http remote that
  passed the network gate (§7.4); `none` for a call that has no remote.
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
`installPolicy` property in the skill package schema. That schema is removed
from `schemas/sdk/` and kept as the host-owned
`schemas/skill-package.schema.json` (§5.6). Tests that assert managed
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
  setting. A base is an https origin. The policy section is read exactly
  (`{ "baseUrl": … }`); an invalid one makes the service unavailable — no
  announcements, no telemetry — rather than falling back to the public base.
  An unpackaged build may name a staging base in the development variable
  `AVE_SERVICE_BASE_URL`, which may be plain http on a loopback host; a
  packaged build never reads it.
- **Domain change.** A `movedTo` is accepted only over https from the current
  base, and only after the new base's own service document names the current
  base in `movedFrom`. The target must be a public DNS name — not an IP
  literal or a single-label host — until the shared network gate (§7.4)
  covers the service base. The accepted move is stored together with the
  build constant it was made under (`~/.ave/marketplaces/service.json`; a
  staging base keeps `service.staging.json`, so a source run never drops a
  production move) and is discarded when an app update ships a different
  constant. A record that cannot be read as a file is ignored, never
  trusted. At most one move is followed per build constant, and a policy
  base never follows one.
- `announcements` and `telemetry` must be paths on the service origin.
  Requests do not follow redirects (a 3xx is a failure) and are capped at
  64 KB for the document and 1 MB for announcements. Unknown document keys
  are ignored; `schemaVersion` gates a breaking change.
- **What stays in force.** A failed refresh leaves no telemetry endpoint,
  and the last announcements are kept only while the base they came from is
  still the base in force. A policy that turns invalid, or names a base the
  app cannot reach, therefore stops the previous base during the session
  too, not only at boot.
- Telemetry posts to the `telemetry` endpoint with no credential and is
  inactive while the document names none. The document is read for
  telemetry only once the user has opted in, at the first event or flush
  (again after a failure, at most every 10 minutes, and once the document
  in force is 6 hours old, so a policy change reaches telemetry even with
  announcements switched off); events are held, up
  to 500, until a document is in force, and dropped if it names no
  endpoint.
- Announcements keep the `MarketplaceAnnouncement` contract (levels,
  `startsAt`/`endsAt`, up to three navigation-only actions, app-version
  filtered actions) and the dismissed-ids behavior. Action labels fall back to
  the `en` label when the active locale is an installed language that the
  announcement does not carry. They are fetched after boot and every 6 hours
  while the update-check switch is on; a failed fetch keeps the list last
  read from the base still in force.
- The static files live in the ave `web/` site
  (`web/public/.well-known/` and `web/public/announcements/`), deployed by the
  site's deploy workflow when a `web/**` change merges; a Pages `_headers`
  rule serves them as JSON with a five-minute cache.

## 12. Managed policy additions

```jsonc
// policy.json (system scope)
"marketplaces": {
  "allow": ["https://github.com/acme/*", "host:git.corp.example", "path:/srv/ave/*"],  // absent = no restriction
  "block": ["host:git.example.org", "path:/tmp/*"],
  "allowHttpHosts": ["git.corp.example"],                           // plain-http hosts that need no confirmation; default none
  "requireHttps": false,                                            // true: plain http is a policy block, allowHttpHosts excepted
  "blockPrivateNetworks": false,                                    // true: internal and this-computer targets are a policy block, policy-listed hosts excepted
  "allowDirectInstall": true,
  "allowLocalSources": true,                                        // false: no folder is a source or a direct install
  "allowDisablingOfficial": false,
  "additional": [
    { "id": "corp", "url": "https://git.corp.example/ave/marketplace.git" },
    { "id": "team-share", "path": "\\\\files.corp\\ave\\marketplace" }      // a folder: `path` instead of `url`
  ],
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
- Policy-listed hosts are those named by `allowHttpHosts`, by an `allow`
  pattern, or by an `additional` source. They need no `unencrypted`,
  `internal-network` or `this-computer` confirmation (§7.4). Metadata and
  unroutable addresses stay refused even for them, and a listing never
  implies `token-unencrypted`: the policy authorizes the transport, not
  sending the user's credentials over it.
- `requireHttps` and `blockPrivateNetworks` apply to entered and
  catalog-supplied targets, downloads and redirect hops included (§7.4).
  `blockPrivateNetworks` is enforced on the connected address of a
  direct connection on the transports Ave owns (downloads, git over
  http/https). For ssh it is a preflight check only. Beyond a proxy that
  resolves the target itself, the trusted proxy enforces it. Both turn back on
  0.12's refusals as blocks that no confirmation passes. Apps up to and
  including 0.13.0 read an unknown key as an invalid section, so deploy them
  only to the release that carries slice C and later.
- Host fields (`host:` patterns, `allowHttpHosts`, `auth.host`) take no port;
  a token's `auth.host` must be the source's own host.
- **Folders** (§7.7). `path:<folder>` matches that absolute folder,
  `path:<prefix>*` every folder whose path starts with the text before the
  `*` (end it with a separator, `path:/srv/ave/*`, to mean the folders below
  one folder), and `path:*` every folder; a `*` anywhere else is rejected.
  `/` and `\` are one separator and a drive letter matches in either case.
  Both lists compare Unicode NFC forms. An `allow` pattern matches the
  spelling written; a `block` pattern also ignores case, so no respelling
  escapes it. `path:` patterns apply
  only to folders and host or URL patterns only to git addresses, so an
  `allow` list with no `path:` pattern admits no folder. A folder is judged
  on its typed path before anything touches it, and again on its canonical
  path after the walk (§7.7 stages 3–4).
- `allowLocalSources` (default `true`): `false` refuses every folder, as a
  source and as a direct install, with `local-sources-blocked`, before any
  filesystem call — also a drive letter's mapping.
- `allowDirectInstall` (default `true`): `false` refuses a direct source, git
  or folder, at the preview, the add and every plan from one added earlier
  (`direct-install-blocked`, §8.2).
- The section is read exactly. An unknown key, a duplicate key, `null` where a
  list belongs, a pattern that does not parse, an `additional` source that the policy's own lists block, or
  an install entry naming a source that is neither official nor `additional`
  makes the whole section invalid; every non-official source is then
  `SOURCE_POLICY_BLOCKED` until the file is fixed. A typo must not fail open.
- `additional` sources are pre-registered with origin `managed`: the user
  cannot remove or hide them and their history rule is the official one. An
  `additional` source is itself a listing, so a plain-http one needs no
  `allowHttpHosts` entry; only under `requireHttps: true` does its host have
  to be in `allowHttpHosts`, or the section is invalid.
- An `additional` entry with `path` instead of `url` is a managed folder. It
  takes no `ref` or `auth`, its path is absolute (`~` names no home in a
  system file) and read for the running platform, and it holds
  `network-folder` through the entry. It makes the section invalid under
  `allowLocalSources: false`, when the policy's own lists block it, and when
  it is, contains or lies inside another `additional` folder.
- `defaultInstalls` and `requiredInstalls` follow §10.2 and may name official
  and managed sources only. A key in both lists is treated as required.
- **A policy change takes effect at the next operation, without a restart.**
  - The service reads the policy through a `PolicySource`
    (`FilePolicySource`, `src/marketplace/sources/policy.ts`). At the start
    of every operation (preview, add, acknowledge, sync, plan, execute,
    listing), it compares the file's size, modification and status-change
    times, inode and device with the last read. A permission change or a
    file renamed into place therefore counts as a change. When they differ,
    it reads the file and compares the sha256 of the content.
  - The recorded times are trusted only when that read began at least
    3 seconds after the file's last change. File times come from a coarse
    clock (a kernel tick on NTFS and Linux, 2 seconds on FAT, the server's
    clock on SMB and NFS), so a rewrite in the same tick as the change the
    read saw, with the size kept and the modification time put back,
    leaves every compared field as it was. After a read inside that
    window, or one that found a change time ahead of the clock, the next
    check reads the file and compares the sha256 again; the first read
    outside the window restores the shortcut. A check that finds the clock
    behind the moment the recorded read began also reads the file.
  - The rule holds while the timestamp granularity, plus how far the
    writer's timestamp clock lags this computer's clock, plus how far this
    clock has stepped back since the read, stays under 3 seconds. Outside
    those bounds (a file server clock lagging further, or a clock stepped
    back and forward again between two checks) a rewrite can be noticed
    late: at the next change that moves the compared fields.
  - A changed policy is applied under the service's exclusive operation
    lock. It takes effect in the gate, the registry's managed sources and
    filters, and the installers at once, so no operation sees a mixed
    policy.
  - Refreshes run through one queue, one at a time. Each one reads the
    file, compares it and, if it changed, applies it before the next one
    begins. The latest read is therefore always the last applied, and no
    read can finish out of order.
  - Every operation waits for a refresh that began no earlier than the
    operation itself, then runs under the policy that refresh left in
    force.
    - A refresh already running may have read the file too early. The
      operation waits for the next refresh instead.
    - Every operation arriving meanwhile shares that one queued refresh.
      Operations that keep overlapping therefore cost one extra read
      between them, and they still see a change within it.
    - A caller can be cancelled (the update scheduler's calls carry its
      shutdown signal). A cancelled caller starts no refresh: it is refused
      on arrival, and a queued refresh whose every caller was cancelled
      while it waited does not start. One live caller is enough for it to
      run. A caller cancelled while it waits for the refresh or the lock
      never enters the operation body.
  - A malformed or unreadable file is applied fail-closed with its warning,
    exactly as a single read would apply it. The change applies whoever
    waits for it; the warning is logged only while a caller that waits for
    the refresh is live, so a refresh that ends after shutdown says nothing.
  - Lock order: a marketplace operation comes before any plugin lifecycle
    lock.
    - An install holds its operation's shared lock, then takes the plugin's
      lock.
    - Code that holds plugin locks and calls the service would invert that
      order. It could wait for a policy change's exclusive lock while an
      install holds the shared lock and waits for the same plugin lock.
    - Such code (removing a retired predecessor from an alert) therefore
      enters one operation first (`asOneOperation`). It takes the plugin
      locks inside the operation, and re-checks authority under both.
  - An operation owns its nested calls only while it runs.
    - The service reports a catalog change outside the operation, so the
      background update check it starts enters an operation of its own,
      with a refresh and the shared lock.
    - Work an operation started that is still running after the operation
      ends does the same.
    - The background scheduler (§7.3: the boot pass, discovery, the apply
      check and the update list) runs every entry (Check now, Retry, a
      recheck, a settings change), resume and its due-check timer in the
      context it was started in, outside any operation. Whatever asks for a check, from inside any operation (a
      sync that published a snapshot, an install), the check's service
      calls are operations of their own. This holds even when the check
      starts while that operation still runs.
  - A plan records the digest of the policy it was made under. Executing it
    under another digest fails `PLAN_EXPIRED` reason `policy-changed`, and
    the sheet offers *Review again*.
  - A policy that becomes unreadable (a permission change included) or
    invalid behaves as an invalid policy at start: official only, with
    `policy-invalid` shown. It recovers at the
    first operation after the file is fixed.
- `autoUpdate` (§18.6) belongs to slice F.

## 13. IPC contract

| Channel | Request | Response |
|---|---|---|
| `ave:marketplace:sources:list` | — | `SourceView[]` |
| `ave:marketplace:sources:preview` | `{ input: string; ref?: string; token?: string; acknowledge?: SourceWarning[] }`, or `{ pick: string; auth: "none"; acknowledge? }` for a folder *Choose folder…* chose | `SourcePreview \| DirectPackagePreview \| { type: "confirm"; warnings }` |
| `ave:marketplace:sources:add` | `{ previewId: string; id?: string }` | `SourceView` |
| `ave:marketplace:sources:acknowledge` | `{ id; warnings: SourceWarning[] }` | `SourceView`, after a sync |
| `ave:marketplace:sources:remove` | `{ id }` | `{ orphanedPackages: PackageKey[] }` |
| `ave:marketplace:sources:set-enabled` | `{ id; enabled }` | `SourceView` |
| `ave:marketplace:sources:refresh` | `{ id? }` | `SyncResult[]` |
| `ave:marketplace:sources:accept-rewrite` | `{ id; commit }` | `SourceView` |
| `ave:marketplace:sources:set-token` / `delete-token` | `{ host; token? }` | `{ ok: true }` |
| `ave:marketplace:sources:pick-folder` | — | `{ pick; display } \| null` (main's folder dialog; main keeps the path; `null` when cancelled) |
| `ave:marketplace:sources:reveal` | `id` (a folder source's; never a path) | `null`, after the shell shows the folder |
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
| `ave:marketplace:updates:status` | — | `UpdateStatusView` (§13.1) |
| `ave:marketplace:updates:check` | — | `UpdateStatusView`, when the apply check's discovery and classification end (§7.3) |
| `ave:git:runtime:status` | — | `GitRuntimeStatus` |
| `ave:git:runtime:install` | — | `GitRuntimeStatus` (progress via event) |

Events: `marketplace:sync-progress`, `marketplace:catalog-changed`,
`marketplace:install-progress` (`{ planId, rung, phase, bytes? }`),
`marketplace:updates-available` (each update with its state, §13.1),
`marketplace:update-status` (`UpdateStatusView` on change),
`marketplace:boot-installs-applied` (default and required installs),
`git-runtime:progress`.

All channels are host-renderer only (`validateHostRendererSender`) and
audited as today. `ave:git:runtime:install` also requires a live keyboard
gesture: it downloads a binary the marketplace then runs. `planId` and `previewId` are single use and expire after 10
minutes (`PLAN_EXPIRED`). Disposition of today's channels is in §16.2.
A folder is previewed and added through `sources:preview` and `sources:add`
like any address; `sources:pick-folder` only fills the address in (and
names the chosen folder by its pick), and
`sources:reveal` only shows a folder source (§7.7, §13.1). The
automatic-update channels (slice F) are in §18.9.

### 13.1 As built

Where the table above and the shipped contract (`CHANNELS.gitMarketplace`,
`GitMarketplaceApi` in `src/shared/git-marketplace.ts`) differ, the contract
wins:

- Every answer is an envelope: `{ ok: true, value }` or
  `{ ok: false, code, message, detail? }`. `code` is a §14 code, `invalid-request`
  (the request shape was refused before the service saw it),
  `unauthorized-frame`, or `unavailable` (the service could not start, or
  failed with something that is not a marketplace error). `detail` is the
  reason and the values its sentence names (§14); `parseGitMarketplaceResult`
  keeps a `detail` whose reason belongs to the code and fields have the
  declared types, and drops any other while keeping code and message.
  `message` is main's English text, shown only behind *Copy details*.
- Main scrubs every string it hands the renderer (§18.8): each answer's
  `value` at any depth, object keys included (an MCP server's name keys
  `components.mcpServers`), each failure's `message` and `detail`, each
  broadcast (`sync-progress`, `install-progress`, `update-status`,
  `updates-available`, the bootstrap status, the git runtime's progress) and
  each held answer (the deep link, the boot-install notice), and the git
  runtime's `status` and `install` answers, with the one scrubber
  (`scrubMarketplaceStrings` over `scrubDiagnosticSecrets`). The marketplace's
  log lines pass it too (`createMarketplaceLogger`). The renderer never
  scrubs an answer or a detail field; it scrubs again only main's `message`
  it shows or copies behind *Copy details*. What it sends back is what main
  can check (`previewId`, `planId`, a source id, a package key, a version, a
  commit, a component's name and digest). Each of those identifiers is
  refused where it enters when the same detector flags it (§18.8), so the
  scrubber leaves every identifier main accepted unchanged and the renderer
  names it back as it was handed. A source an earlier build stored under
  such an id is listed under a handle main issues, which Remove takes
  (§18.8). A masked value sent back matches nothing and is refused, never
  taken for another. A deep link's `add` address that held a token's shape
  prefills the Add dialog masked, for the user to correct; an `install` or
  `uninstall` link whose package or source has one is not read as a link.
- `sources:preview` takes `{ input; ref?; subdir?; auth: "none" | "token" |
  "ssh"; token?; acknowledge? }`. It answers a marketplace preview, a
  direct-package preview (each with `badges`), or `{ type: "confirm";
  warnings }` when the address needs confirmations that `acknowledge` does not
  carry (§7.2 step 2). A direct install from a git folder goes through it with
  `subdir`. `acknowledge` holds only the warnings of §2.1, each once; *Add*
  stores exactly the preview's.
- A folder goes through the same preview (§7.7). It takes no `ref`,
  `subdir`, sign-in or token (`SOURCE_URL_REJECTED` `folder-options`); a
  folder on another computer answers `{ type: "confirm"; warnings: [{
  warning: "network-folder", host, address }] }` (`host` the server, `null`
  when the drive's mapping names none). Every preview and `SourceView`
  carries `transport: "git" | "folder"`; a folder's has `url: null` and its
  canonical `path`, and a preview adds `resolvedFrom` (the typed input, when
  the walk resolved a link) or `null`. A folder's `commit` and `pinnedCommit`
  are its `local-` revision. `InstallPlan` carries `notInstalled` (a folder
  plugin's top-level entries left out; empty otherwise), a `RungView` and the
  install progress may name the `folder` rung, and a package's provenance
  carries `repository` or `folder`, the other `null`. `folder` is `{ path;
  readAt; contents }`: the canonical path, when the folder was last read
  (the last successful sync, else the snapshot's `fetchedAt`), and the
  package's tree digest (`null` for a package that has none).
- `sources:pick-folder` (`pickFolder` in the preload) shows main's folder
  dialog over the window that asked and answers `{ pick, display }`, or
  `null` when the user cancels; it reads nothing and builds no service.
  Main keeps the chosen path. `display` is that path scrubbed like every
  answer to the tab (§18.8), for the address field only: masked text is not
  an address (a masked name can name another folder, or none), so the tab
  previews the chosen folder as `{ pick, auth: "none", acknowledge? }` and
  main reads the path it kept. A pick is one selection at a time: a newer
  pick replaces it, an add drops it, it expires after 15 minutes and lives
  only as long as the process; any other pick, forged or stale, is
  `SOURCE_URL_REJECTED` `folder-pick-unknown` ("… Choose the folder
  again."). A preview by pick takes no `input`, `ref`, `subdir`, token or
  sign-in (`invalid-request`). A path typed into the field, even one shown
  from a pick and then edited, is the user's text and is previewed as
  typed; its echo is scrubbed as always. A dialog that
  could not open is `unavailable`. `sources:reveal` (`revealSource`) takes a
  source id and answers `null` once the shell was asked to show the folder;
  a git source is `invalid-request`, and the folder is judged as a read
  would judge it first (§7.7).
- A folder's `badges` are `local-folder` or `network-folder` (§7.7), on the
  preview, the `SourceView` and its catalog entries' `sourceBadges`.
- `remove`, `set-enabled`, `accept-rewrite`, `set-token`, `delete-token` and
  `acknowledge` take positional arguments (`id`, `enabled`, `commit`, `host`,
  `token`, `warnings`), and `refresh` answers `SourceView[]`. `acknowledge`
  (`acknowledgeSource` in the preload) adds confirmations to a source of any
  origin and syncs it again. The IPC domain refuses an empty list or an
  unknown warning as `invalid-request`.
- `SourceView` carries `acknowledged` and `badges`, and a catalog entry
  carries its source's badges as `sourceBadges` (§15.1). A `RungView`
  carries `unencrypted` for a plain-http download (§15.2).
- `catalog:list` answers `{ entries, counts, sourceCount, syncedAt }`.
  `uninstall` takes `{ sourceId | null; kind; name; removeData? }`:
  `sourceId: null` is a package bound to no source, and `removeData` applies to
  MCP servers only (§5.2).
- `direct:preview` takes `{ serverJson; select?: { package? | remote? } }` only
  and answers the command that will run, with a `planId` that
  `install:execute` consumes. A pasted MCP config uses the MCP settings import;
  a git folder uses `sources:preview`.
- `InstallResult.connectionWarning` is set when an MCP server was saved but did
  not connect; the result says so, not "installed".
- Added: `deep-link:take`, `boot-installs:notice` and `boot-installs:dismiss`,
  with the events `marketplace:deep-link` and
  `marketplace:boot-installs-applied`. Main holds a deep link, or the boot
  step's notice, until the tab reads it: a link that arrives before the window
  or the tab exists still lands. A refused frame consumes nothing.
- Deep links open the confirming UI and nothing more.
  `ave://install|uninstall/<kind>/<name>@<source>` opens the package's sheet;
  `ave://marketplace/add?url=` opens the Add dialog with the address filled in
  but unchecked. A link whose address is a path or a `file:` URL is refused
  (§18.3 #7): it is delivered as `{ action: "add-refused"; reason:
  "deep-link-path" }`, and the dialog opens empty and says why. The legacy `ave://install/<slug>` links keep their parser;
  the two shapes never overlap.
- Announcements reach the renderer on the existing pushed announcement event,
  not through a request channel.
- A plan is live until it is used, expires, or is replaced: planning a package
  again drops its older plan. An unused plan or preview is dropped at expiry
  even if nothing else happens, so an abandoned preview's clone and typed token
  do not linger.
- `updates:status` and `updates:check` answer from the scheduler (§7.3):

  ```ts
  interface UpdateStatusView {
    discovery: { lastAttemptAt: string | null; lastSuccessAt: string | null;
                 result: "ok" | "partial" | "offline" | "error" | null;
                 nextAt: string };     // the earlier of the discovery and apply-check due times, not before now
    applyCheckAt: string | null;
    running: boolean;                  // a discovery or an apply check is in flight
    historyReset: boolean;             // updates.json could not be read and was started again
    packages: PackageUpdateView[];     // updates from the sources the last discovery reached, minus skipped versions,
                                       // each with its state; an unreached source's only as shown before, `stale: true`
  }
  ```

  A package's `state` is one of §18.7.5's eight (`UPDATE_PACKAGE_STATES`).
  `stale: true` marks a package whose source the last discovery did not
  reach: its state is an earlier discovery's, not a new classification
  (§7.3). Before the window has loaded, and in an isolated E2E run, there
  is no scheduler: both answer `unavailable`, whose message ("update checks
  have not started") is behind *Copy details*.
  `marketplace:update-status` carries the same view whenever it changes.
- `marketplace:updates-available` carries `PackageUpdateView` with its
  `state`, and only states that need the user (`updateNeedsUser`:
  `needs-review`, `manual`, `failed`, `applied-not-running`,
  `approval-pending`); `manual` only while update notices are on
  (`updateCheckEnabled`). Skipped versions are left out in main.
- Marketplace-installed MCP servers are recorded in
  `packages/mcp-installs.json`. A pasted server is recorded with no source, and
  only recorded servers can be updated or uninstalled here. The MCP governance
  policy (Layer 1) is checked when the plan is made and again at install
  (`PACKAGE_POLICY_BLOCKED`).
- Message keys live under `gitMarketplace.*` (e.g.
  `gitMarketplace.error.authRequired`) until P6 retires the old tab's
  `marketplace.*` keys. The tab is shown only with `AVE_GIT_MARKETPLACE=1`
  (`window.ave.env.gitMarketplace`) until P6.

## 14. Error codes

Every code has a reason-less sentence; a code with reasons has one sentence
per reason, chosen when the failure carries a `detail` (§13.1). The sentence
says what happened and what to do; main's English `message` is reachable
only through *Copy details*. `failureText` (`labels.ts`) is exhaustive over
the codes and reasons, with no `default`, and `labels.test.ts` enumerates
`MARKETPLACE_ERROR_CODES` and `MARKETPLACE_ERROR_REASONS` (`errors.ts`).
Keys live under `gitMarketplace.error.*`; source policy blocks under
`gitMarketplace.policy.*`, so the MCP governance sentence
(`gitMarketplace.error.policyBlocked`) never mixes with them.

A source failure's sentence also depends on what it is about
(`FailureSubject`): an address being typed (Add marketplace, Install from Git
URL), a listed source by its origin, sign-in and whether a token is stored,
or no one source. It never asks the user to check a field they cannot
change: an address, branch or folder is advice only for an address being
typed or a source the user added (`Remove source`, then add it again). The
official source gets *Refresh* and the marketplace's owner, an organization
source the administrator. A sign-in sentence names the step the row offers:
*Set token…* on a token source's row (to add one, or to replace a stored one
that may lack access), *Remove source* and add again with a token for a
source the user added without one, the administrator for an organization
source set up without one. Each variant is a key suffix (`.custom`,
`.managed`, `.owned`, `.entry`, `.setToken`, `.rejected`, `.readd`,
`.other`), and `labels.test.ts` checks every code and reason against every
subject in both catalogs.

| Code | When | Reasons (detail fields) | Sentence key |
|---|---|---|---|
| `GIT_RUNTIME_MISSING` | no usable git | — | `gitMarketplace.error.gitMissing` |
| `GIT_RUNTIME_TOO_OLD` | system git older than 2.45.1 in `system` mode | — | `.gitTooOld` |
| `GIT_RUNTIME_INSTALL_FAILED` | managed download/verify/extract/smoke test failed | the phase: `checking`, `downloading`, `verifying`, `extracting`, `smoke-testing`, `installing` (the final move into place) — no fields | `.gitInstallFailed`, `.gitInstallFailed.<phase>` |
| `SOURCE_URL_REJECTED` | the refusals of §18.3 #1–4 and #7, and unsupported input, a folder path included; no confirmation exists | from the normalizer: `credentials-in-url`, `helper-transport` (scheme), `scheme-unsupported` (scheme), `format` (query, fragment, whitespace, control character or backslash); from the gate, on the address a connection would use: `address-metadata` (host, address), `address-unroutable` (host, address), `catalog-this-computer` (source, host); from the deep link: `deep-link-path`; from a folder path (§7.7): `relative-path`, `device-path`, `windows-path`, `network-file-url`, `unc-without-share`, `unc-credentials`, `outside-root`, `folder-options`; from a *Choose folder…* pick main no longer holds: `folder-pick-unknown`. A download URL's own refusals carry none | `.urlRejected`, `.urlRejected.<reason>`; the two address reasons say "check the address" only for an address being typed or a source the user added, and otherwise (`.network`) name a VPN, proxy or hosts file and the administrator |
| `SOURCE_POLICY_BLOCKED` | managed policy allow/block, `requireHttps`, `blockPrivateNetworks`, `allowLocalSources`, `allowDirectInstall`, or an unreadable policy for a non-official target | `blocked-by-pattern` (target, pattern, policyPath), `not-in-allow-list` (target, policyPath), `https-required` (target, policyPath), `private-network-blocked` (target, address, policyPath), `local-sources-blocked` (target, policyPath), `direct-install-blocked` (target, policyPath), `policy-invalid` (error) | `gitMarketplace.policy.blocked`, `.blockedByPattern`, `.notInAllowList`, `.httpsRequired`, `.privateNetworkBlocked`, `.localSourcesBlocked`, `.directInstallBlocked`, `.policyInvalid` |
| `SOURCE_CONFIRMATION_REQUIRED` | a target needs a confirmation the source does not hold (§7.4): at a sync, plan or install, or a download that no source names | the warning: `unencrypted` (host), `token-unencrypted` (host), `internal-network` (host, address), `this-computer` (host, address), `internal-downloads` (source, host), `network-folder` (server, path: a folder on another computer, at a read of a folder source that does not hold it) | `.confirmationRequired`; with a reason, `gitMarketplace.warning.<warning>` (the confirmation's own question; `internalNetwork.proxyRange` for a `198.18.0.0/15` address; `networkFolder.unknownServer` when the drive's mapping names no server and `networkFolder.automount` on macOS and Linux) |
| `SOURCE_NAME_RESERVED` | reserved id | — | `.nameReserved` |
| `SOURCE_ID_INVALID` | id is not 2–63 lowercase letters, digits or `-`, or names no source; or the id being added has a credential's shape, or a request other than Remove names a quarantined source (§18.8) | `reserved-prefix` (`prefix`, `issuer`), `holds-credential`, `stored-id-holds-credential` | `.idInvalid`, `.idInvalid.reservedPrefix`, `.idInvalid.holdsCredential`, `.idInvalid.storedIdHoldsCredential` |
| `SOURCE_ID_TAKEN` | id or repository already added; a folder that is a source, or contains or lies inside one (§7.7) | a repository or a folder: `repository-already-added` (url, existingId) — any spelling of its address, `url` the one being added, normalized; `folder-already-added` (path, existingId), `folder-inside-source` (path, existingId, existingPath), `folder-contains-source` (path, existingId, existingPath) — by path or through an alias. A taken id alone has none | `.idTaken` (the id: choose another); `.idTaken.repositoryAlreadyAdded`, `.folderAlreadyAdded`, `.folderInsideSource`, `.folderContainsSource`, which say to use or remove the other source, never to choose another id |
| `SOURCE_AUTH_REQUIRED` | 401/403, ssh denied; a "repository not found" after Ave offered the stored token | `token` (host), `token-no-access` (host: the host answered "repository not found" to the stored token, which may lack access), `token-unencrypted` (host: the host wants sign-in over plain http and the source does not hold `token-unencrypted`, so no credential was offered), `ssh` (host) — from git's message; a download's refusal carries none, since its host need not be the token's | `.authRequired`, `.authRequired.token`, `.authRequired.tokenNoAccess`, `.authRequired.ssh`, each with the variants below; `.authRequired.tokenUnencrypted` with `.entry` and `.setToken` |
| `SOURCE_SSH_HOST_UNKNOWN` | host key not in known_hosts, or different from it | `unknown` (host, port), `changed` (host, port) — `changed` when ssh prints "remote host identification has changed"; the sentence carries the `ssh-keyscan` or `ssh-keygen -R` command, which *Copy command* copies | `.sshHostUnknown`, `.sshHostUnknown.unknown`, `.sshHostUnknown.changed` |
| `SOURCE_REF_NOT_FOUND` | branch or tag missing | `missing` (ref, repository, available) — after the fetch fails, `ls-remote` lists up to 10 branches, then tags | `.refNotFound`, `.refNotFound.missing` |
| `SOURCE_UNREACHABLE` | network, DNS, timeout, a host that reports no repository | `offline`, `dns`, `refused`, `timeout`, `http-status` (status), `tls`, `proxy` (proxy), `not-found` and `not-found-ssh` (the host answered "repository not found" without a token from Ave, which hosts also answer for a private repository, so neither is claimed) — each with host but `offline`; from git's message, the gate's resolver error, the run's own timeout, an unusable PAC entry, or a download's status | `.unreachable`, `.unreachable.<reason>` |
| `SOURCE_NOT_A_MARKETPLACE` | nothing recognizable | — | `.notAMarketplace` and its variants |
| `SOURCE_INDEX_INVALID` | index failed validation; or a direct package (or a pasted `server.json`) has a name, version or component name with a credential's shape (§18.8). A marketplace's package with one is dropped with a diagnostic instead | `name-reserved-prefix`, `version-reserved-prefix`, `component-reserved-prefix` (each `prefix`, `issuer`), `name-holds-credential`, `version-holds-credential`, `component-holds-credential` | `.indexInvalid`, `.indexInvalid.<reason>` |
| `SOURCE_HISTORY_REWRITTEN` | non-descendant candidate | — | `.historyRewritten` |
| `SOURCE_DISABLED` | install or update requested from a hidden source (it still syncs for packages bound to it, §7.3) | — | `.sourceDisabled` |
| `SOURCE_LOCAL_DATA_DAMAGED` | the source's downloaded copy cannot be used (§2.1); a Repair that could not move it aside or write the kept pin back | pin lost: `state-missing`, `state-invalid`, `state-unreadable`; pin kept: `snapshot-invalid`, `snapshot-unreadable`, `repository-damaged`; Repair: `repair-failed` (a pin was kept), `repair-failed-unpinned` (none to keep), `repair-write-failed` (sourceId) — a message names files relative to the source and an fs error by its code, never a home path; a sentence names the source as its row does (the official source by its origin's name, another by its label, the id only when no listed source is known) | `.localDataDamaged`, `.localDataDamaged.<reason>` |
| `SOURCE_LIST_UNREADABLE` | `marketplaces/sources.json`, the list of sources the user added, cannot be read or is not in Ave's format; every source change is refused until the user fixes or deletes it (no repair: it is the user's data) | `unreadable` (fsCode), `invalid` — the message names the file and an fs error by its code, never a home path | `.listUnreadable`, `.listUnreadable.<reason>` |
| `SOURCE_LOCAL_UNREADABLE` | a folder source, or a folder being added, cannot be read (§7.7); the last good snapshot stays served and the next read tries again | `not-found` (path), `permission` (path, message), `io` (path, message), `moved` (path, target: the stored path now leads elsewhere, which is not read), `not-a-directory` (path), `ambiguous-case` (path: two entries match the typed name ignoring case on a case-sensitive volume), `changed-during-read` (path), `classifier-unavailable` (path: the Windows folder classifier is missing or broken, so Ave cannot tell whether the folder is on another computer) — `message` is the system's, scrubbed | `.localUnreadable`, `.localUnreadable.<reason>`; `notFound` with `.entry` (a folder being typed) and `.managed`, `moved` with `.managed` |
| `PLAN_EXPIRED` | plan/preview id expired or reused, or made under another managed policy (§12) | `policy-changed` | `.planExpired`, `.planExpired.policyChanged` |
| `PACKAGE_INCOMPATIBLE` | no version is offered to this installation: `minAppVersion` above the app version, another platform, a pre-release without canary, or a rollout that excludes it | `min_app_version` (name, version), `platform` (name, platform), `host_protocol` (name) — when the excluded version is known | `.incompatible`, `.incompatible.minAppVersion`, `.incompatible.platform`, `.incompatible.hostProtocol` |
| `PACKAGE_COMPAT_UNDECLARED` | git-installed plugin without `requires.minAppVersion` | — | `.compatUndeclared` |
| `PACKAGE_YANKED` / `PACKAGE_REVOKED` | every version is yanked or revoked (revoked when all are revoked) | — | `.yanked` / `.revoked` |
| `PACKAGE_ID_CONFLICT` | same `(kind, name)` installed from another source, or from no source; also a signed-catalog install, update or rollback over a git-bound plugin | — | `.idConflict` |
| `PACKAGE_REQUIRED_BY_POLICY` | uninstall or disable of a `requiredInstalls` package | — | `.requiredByPolicy` |
| `PACKAGE_POLICY_BLOCKED` | the MCP governance policy refuses the server (Layer 1), at plan and again at install | — | `.policyBlocked` |
| `ARTIFACT_NOT_PINNED` | rung skipped: no sha256 in git | — | `.artifactNotPinned` |
| `ARTIFACT_DIGEST_MISMATCH` | sha256 differs | — | `.digestMismatch` |
| `MANIFEST_MISMATCH` | plugin.json vs descriptor | — | `.manifestMismatch` |
| `process-entry-unconfined` | a `process` entry while the OS tool sandbox is off, or on Windows (§18.4.9) | — | `formatIpcError.processEntryUnconfined` |
| `process-entry-requires-pinned-artifact` | a `process` entry not installed from a sha256-pinned release or archive artifact (§18.4.9) | — | `formatIpcError.processEntryRequiresPinnedArtifact` |
| `NO_INSTALLABLE_ARTIFACT` | every rung skipped or failed (`SOURCE_AUTH_REQUIRED` instead when every failed rung needed sign-in) | `folder-has-no-build` (name: a folder plugin without `plugin.json`, §7.7) | `.noArtifact`, `.noArtifact.folderHasNoBuild` |
| `CONTENT_RULE_VIOLATION` | content kind file rules; a folder's reading rules (§7.7) | `link-outside-folder` (path, target), `link-to-network` (path, target), `link-to-skipped` (path, target), `special-file` (path), `case-collision` (path), `limit` (path, limit) — `path` relative to the folder; `target` the link's own text, for `link-to-skipped` the skipped entry it reaches | `.contentRule`, `.contentRule.<reason>` |
| `invalid-request`, `unauthorized-frame`, `unavailable` | envelope only (§13.1) | — | `.invalidRequest`, `.unauthorizedFrame`, `.unavailable` |

A failure is shown by `MarketplaceProblem` in one of three tones (§18.8):
policy (`SOURCE_POLICY_BLOCKED`, `PACKAGE_POLICY_BLOCKED`,
`PACKAGE_REQUIRED_BY_POLICY`), warning, or error. The warning tone asks a
question with *Cancel* and *Continue* (the Add dialog's confirm step). A
failure the user can allow is `SOURCE_CONFIRMATION_REQUIRED` with a reason, or
`SOURCE_AUTH_REQUIRED` `token-unencrypted`. It renders amber, with *Allow…*
(*Allow internal downloads* for `internal-downloads`). The button calls
`sources:acknowledge` with that warning (`allowableWarning`, `labels.ts`). A failure outside these
codes (a settings write, a plugin file, a pasted MCP configuration) uses the
error tone with its own sentence. Every message is scrubbed
(`scrubDiagnosticSecrets`, `src/shared/dlp.ts`: URL userinfo, authorization
and token values, credential-helper lines) by main before it enters the
envelope, by the normalizer before it echoes a refused address, and again by
`MarketplaceProblem` before *Copy details* copies it. Beyond messages, one
rule holds (§13.1): every string the marketplace hands the renderer or writes
to a log passes that one scrubber in main, with no field exempt. A detail's
fields, identifiers included (a grammar that admits a name admits a token of
the same shape), are scrubbed wherever a detail crosses or is stored; the
renderer puts them in a sentence as they arrive and never scrubs again. When
the host of an unknown or changed SSH host key came back masked, the sentence
says part of the server name looked like a token and offers no command, since
a command naming a masked host would not run.

#### The credential detector contract

One detector (`src/shared/dlp.ts`) does two jobs: main's scrubber masks what
it finds in every string it hands the renderer or a log, and ingress refuses
every identifier in which it finds anything (`holdsCredential(text)`: the
scrubber would change `text`). This section is its contract; the tests in
`src/audit/__tests__/dlp-redact.test.ts` hold the code to it.

**Formats found by their prefix.** A row is found where its prefix starts
at a left boundary, and masked whole:

| Issuer | Prefix | Body after the prefix |
| --- | --- | --- |
| GitHub classic, OAuth, user-to-server, server-to-server, refresh | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` | 36 or more letters and digits |
| GitHub App installation, stateless | `ghs_` | `<letters and digits>_` then a JWT (`eyJ…` and three base64url segments) |
| GitHub fine-grained | `github_pat_` | 22 letters and digits, `_`, 59 or more letters and digits |
| GitLab | `glpat-`, `gldt-`, `glrt-`, `glptt-`, `glcbt-`, `glsoat-` | 20 or more of letters, digits, `_`, `-`, then any `.`-separated segments |
| npm | `npm_` | 36 or more letters and digits |
| Slack | `xoxa-`, `xoxb-`, `xoxp-`, `xoxo-`, `xoxs-`, `xoxr-`, `xoxe-` | 6 or more digits, `-`, 8 or more of letters, digits, `-` |
| Slack app-level | `xapp-` | a digit, `-`, capitals and digits, `-`, digits, `-`, letters and digits |
| AWS access key id | `AKIA`, `ASIA` | 16 or more capitals and digits |
| Google API key | `AIza` | 35 or more of letters, digits, `_`, `-` |
| OpenAI | `sk-` | 48 or more letters and digits |
| OpenAI project, service account, admin | `sk-proj-`, `sk-svcacct-`, `sk-admin-` | 40 or more of letters, digits, `_`, `-` |
| OpenAI, signed | `sk-` | any of letters, digits, `_`, `-` holding `T3BlbkFJ` |
| Anthropic | `sk-ant-api`, `-admin`, `-sid`, `-oat`, `-ort` and two digits, `-` | 32 or more of letters, digits, `_`, `-` |
| Stripe | `sk_`, `pk_`, `rk_` then `live_` or `test_` | 24 or more letters and digits |
| JSON Web Token | `eyJ` | 5 or more base64url characters, `.`, 5 or more, `.`, 5 or more |
| PEM private key | `-----BEGIN … PRIVATE KEY-----` | through `-----END … PRIVATE KEY-----` |

Boundary rules, the same for every row:

- **Left: a boundary.** A prefix starts a format at the start of the text
  or after any character that is not an ASCII letter or digit: `_`, `-`,
  `.`, `/`, `:`, `=`, a space, a quote. `backup_<token>`, `x-<token>`,
  `market-<token>`, `id=<token>` and `//server/share/<token>` are found. A
  prefix glued to a letter or digit is not: `task-proj-build-the-user-interface…`
  is the word `task`, not `ta` and an `sk-proj-` key.
- **Right: none.** The body is read greedily over the row's alphabet and
  counts once it reaches the row's length, whatever follows: `<token>_old`,
  `<token>.example.com` and a Google key whose body ends in `-` are found.
  The whole run is masked.
- **Case: as issued.** Every prefix and alphabet is case-sensitive.

**Formats found only where a credential stands.** A credential with no
prefix of its own (an Azure DevOps personal access token, which is 52
characters of lowercase base32 like any base32 digest; a password; any
other opaque secret) is masked only in these positions:

- URL userinfo: everything before `@` in an `http(s)` address, and a
  `user:password` (or any userinfo that is not an ssh account name) in any
  other address or in scp form;
- the value of an `Authorization` or `Proxy-Authorization` header, of any
  scheme, known or not (`Custom <secret>`): everything after the header name
  to the end of its line, or of the text, and through any folded
  continuation lines (lines that start with a space or a tab). A quote
  never ends it, whether one opens the value, stands around the header in
  a longer text (a JSON message, a quoted error) or stands inside it
  (`O'Neil`, `Couldn't`): no quote can be told from a delimiter, and
  masking the rest of a line costs only display while stopping early leaks
  the secret. A redaction marker already in the value is not trusted
  (`[REDACTED:TOKEN] <secret>`, or a folded line after it): the whole value
  becomes one marker, so a value that is one marker stays one marker. The
  header is read by one forward rule, with no quote pairing and no escape
  depth. The name is `authorization` as a delimited word, case-insensitive,
  each letter as itself or `\u`-escaped: it starts the text or follows any
  character but a letter or digit, or an escape sequence
  (`x-authorization:`, `proxy_authorization:`, `\nAuthorization:` in a JSON
  string), and the character after it, decoded, is no letter or digit, or
  there is none. From the end of the word the key's remainder runs forward
  to the first `:` or `=`, raw or `\u`-escaped: every other character is
  remainder, whatever it is, a quote at any escape depth, an apostrophe, a
  space, escaped punctuation. So `Authorization`, `Proxy-Authorization`,
  `authorization_header`, `x-authorization-token`, `authorization.value`,
  `AUTHORIZATION_URL`, `{"authorization header":…}`,
  `{"client's authorization header":…}` and
  `{"client \"authorization header":…}` are all header keys, and
  `xauthorization` and `authorizationfoo` are not. The read is bounded: at
  most 256 reads (`KEY_WINDOW`), the separator's own read included. One read
  is one UTF-16 code unit (a raw character outside the BMP takes two, as its
  escaped surrogate pair does), one `\u` escape with its four hex digits at
  any backslash depth, or one run of backslashes that spells no `\u`
  escape. Whitespace before a raw line break takes one read per unit; the
  read that meets a raw CR or LF also takes the separator whitespace after
  it (raw or escaped, blank lines included), so that whole run is one read.
  Only one raw line break may be crossed. So `authorization` with 255
  underscores and then `:` is a header key, and with 256 it is not; 254
  spaces, a line break and `:` is one, 255 spaces before the break is not,
  and a break followed by 300 spaces and `:` is one. When no separator
  stands inside the bound the word is no header key and nothing is masked; a key whose
  remainder takes more than 256 reads is out of scope. The bound is also
  what keeps the stage linear: every character is read only by the windows
  of the few names that stand within one window before it. After the
  separator comes separator whitespace, classified by one predicate, JS
  `\s`, which by the language's definition holds the line terminators (CR,
  LF, U+2028, U+2029), U+FEFF and every Unicode space separator (NBSP, EM
  SPACE, …). A raw character is classified by it directly; an escape
  sequence at any backslash depth (`\n`, `\r`, `\t`, `\f`, `\v`, `\u` and four
  hex digits; `\\\t`, `\u00a0`, `\uFEFF`) is decoded first and its character
  classified by the same predicate, so there is no list of escaped forms to
  drift from the raw one. The value starts at the first character after
  that whitespace and runs to the end of the line it starts on, through
  folded lines, or to the end of the text. A `--authorization` flag counts
  too. A key that holds `:` or `=` itself (`authorization:header`,
  `authorization\u003aheader`) is masked from that character: its value is
  on the same line in every serialized form, and a value on a later line
  after such a key is out of scope. Accepted consequences of the rule, all
  over-masking: `authorization_url=https://…` is masked (a key the grammar
  once skipped, `authorization_header="Basic …"`, leaked its value); prose
  with a separator after the word within the bound is masked after it
  (`authorization flow: PKCE`); model-bound text loses those values; and
  `memory_write` refuses a memory holding one, its refusal naming the
  reason, a value under an Authorization-like key, in English and Korean,
  so the user can rephrase the fact without it. One stage,
  `maskAuthorizationValues`, is the only code that reads `authorization`:
  both scrubbers run it first, with one value-span function, and nothing
  else in either does. A credential assignment whose key also holds a
  credential word (`x-authorization-token`) finds the stage's marker past
  the same separator whitespace and leaves it, so both scrubbers mask the
  same span. A
  `Bearer` value; an `x-api-key` or `x-auth-token` value;
- the value of a credential assignment (`key=value`, `key: value`, JSON
  `"key": "value"`, `--key value`) whose key holds `token`, `secret`,
  `password`, `passwd`, `pwd`, `apikey`, `accesskey`, `privatekey`,
  `credential` or `bearer`, or has `auth` or `pat` as a
  whole segment (`AZURE_DEVOPS_EXT_PAT=…`, `pat=…`; not `path=`);
- a query parameter `api_key`, `token`, `access_token` or `refresh_token`.

Anywhere else such a value passes unchanged, so a 52-character base32 digest
in build metadata (`1.0.0+<digest>`) is kept.

**Not credentials.** A bare word is no format: `test-`, `live-`, `proj-`,
`npm-`, `pk-`, `rk-`, and a prefix whose body is shorter than its row's
(`glpat-rotation-docs`, `sk-proj-tools`, `test-marketplace2026`,
`laughs_compilation-of-the-best-moments.mp4`) pass, and so does a prefix
glued to a letter or digit (`task-proj-build-the-user-interface-for-the-marketplace`,
`task-<SHA-224 hex>`, `npm_scripts`, `akiak-production`). Commits (40 hex),
SHA-256 digests (64 hex) and folder revisions (`local-<64 hex>`) pass.

**Reserved names.** A name that holds a row's prefix at a left boundary,
with a body as long as the row's, is in a reserved namespace whatever the
body says: `glpat-rotation-documentation-for-local-marketplaces`,
`docs-glpat-rotation-documentation-for-local-marketplaces`,
`sk-proj-build-the-user-interface-for-the-marketplace`, `sk-<SHA-224 hex>`
and the build metadata `1.0.0+sk-<SHA-224 hex>` are refused like the tokens
they look like. This is the stated exception to "ordinary names pass": the
detector reads shape, not meaning, and a prose or digest body under a
prefix has a real token's shape. The refusal is never a "why won't this
work" moment: it names the prefix and the issuer it looks like, and says
what to do. Main finds them with `reservedPrefixIn(text)` (the earliest
row in `text`, the table's earlier row where two start together; the table
lists every row whose prefix extends another row's first, so `sk-ant-` and
`sk-proj-` come before `sk-` and a key that also carries OpenAI's signature
is still named an Anthropic key) and
refuses with the prefix and the issuer in the detail: a source id with
`SOURCE_ID_INVALID` `reserved-prefix`, a package's name, version or
component name with `SOURCE_INDEX_INVALID` `name-`, `version-` or
`component-reserved-prefix`, and an index entry with a diagnostic that
names the prefix. The sentence reads, for an id: "Ids starting with
“glpat-”, or with a part after “-” starting with it, are reserved because
they look like a GitLab token. Choose a different id." The Add dialog
shows the same sentence under the id as it is typed and holds Add until
the id changes. A name with a credential's shape but no prefix (an
assignment, URL userinfo) is refused with the `*-holds-credential` reason
and its own sentence.

**One detector, so admission and egress agree.** Egress masking, ingress
refusal and quarantine all ask the same detector. Whatever admission
accepts, egress returns unchanged, and the renderer names it back as it was
handed. The owner's rule decides the ambiguous cases: refusing an ordinary
name (a "why won't this work" moment) costs more than the residual below,
so a boundary is required on the left.

**Out of scope.** The detector does not find:

- a token lowercased, uppercased or otherwise re-cased (it no longer
  authenticates);
- a bare 40-hex GitHub token of the pre-2021 format, which has the shape of
  a commit that identifiers must keep;
- an Azure DevOps token in its 84-character format, or in its 52-character
  format outside the positions above;
- an unprefixed password or opaque secret outside the positions above;
- a token whose prefix is glued to a letter or digit (`backup<token>`): the
  accepted residual of the left boundary;
- a format not in the table.

Text bound for a model (`scrubSecretsForLLM`) applies the same table and
keeps its older broad prefix rules on top, where a name masked by mistake
costs nothing. Its Authorization values are masked by the same pass as
diagnostics, so both mask the same span.

**Where ingress applies it.** Every identifier the renderer names back is
checked where it enters: a source id being added (`SOURCE_ID_INVALID`
`reserved-prefix` or `holds-credential`) or listed by the policy (the policy is refused, §18.6);
a package's name, version or component name (skill, MCP server, prompt,
agent, routine) in an index entry or a descriptor, synthesized ones
included; and a stored snapshot each time it is read, offline or after a
refresh that keeps the commit, since one written before this rule can still
list such a package. A marketplace leaves that package out with a
diagnostic naming it by its position; a direct package or a pasted
`server.json` fails with `SOURCE_INDEX_INVALID` and the reason. An
`install` or `uninstall` deep link naming one is not read. Egress scrubbing
stays universal, and for every identifier that passed changes nothing, so a
source and a package keep working through every request the renderer makes.

**A source an earlier build stored under such an id** is still read (the
list stays readable) but quarantined: it is not synced, its packages are
not served, even to packages installed from it, and its row has the status
`id-holds-credential` with the sentence "This source's id looks like a
password or token, so Ave does not sync it or offer its packages. Remove
the source and add it again with another id." The row's `id` is a handle
main issues (`ave-legacy-` and an HMAC of the stored id under a key drawn
when the service starts), never the masked id; Remove resolves it against
the stored entries, and any other request naming it fails with
`SOURCE_ID_INVALID` `stored-id-holds-credential` and the same sentence.
A package installed from it is listed under the same handle, and Uninstall
takes it back. The handle is only a view's name: a request from a view is
resolved from it to the install record's stored identity once, at the
entry, and the removal itself, like every caller in main (revocation
enforcement, predecessor removal), names the package by that stored
identity. An add refused for duplicating it (`SOURCE_ID_TAKEN`
`repository-already-added` or a folder overlap) names it by the same
handle, in the detail's `existingId` and the message, so *Show <id>* opens
its row and the stored id never leaves main. A quarantined folder source is
not classified: its row has no badge and no *Show in Finder*, and
`sources:reveal` by its handle or stored id is `SOURCE_ID_INVALID`
`stored-id-holds-credential`. A package installed from it opens a sheet
whose detail is refused with that reason, before and after the source is
removed (the handle still names the install record); the sheet shows the
sentence and keeps *Uninstall*, keyed by the row's handle. More generally,
a sheet opened from a card whose package is installed from that key
(*Installed*, *Update*, *Source removed*) keeps *Uninstall* whenever its
detail is refused.

A background sync's failure reaches the Sources view through `sources:list`:
`SyncResult` carries the detail, the syncer stores it in
`state.json` `lastSync.detail`, the state validator keeps it only when its
reason belongs to `lastSync.result` (and drops it, keeping the code,
otherwise), and `sourceStatus` copies it into the `unreachable` and
`auth-required` views (§15.4).

A folder source's background read fails the same way: its
`SOURCE_LOCAL_UNREADABLE` detail is stored in `lastSync.detail` and its row
names the reason (*Folder not found*, *Folder unreadable*, *Folder moved*)
with the sentence above. Later slices add the update reasons §18.8 lists
for situations this build does not yet distinguish. Each slice that adds a
code or reason adds its sentences (§18.8, §18.10).

## 15. UI specification

The mockup shows every state below. Settings → Marketplace becomes the in-app
store (the web store is gone). A folder source looks like a git source with
its folder where the repository would be: its row (§15.4), its package's
provenance and delivery (§15.2) and the add dialog (§15.5) say so. The
folder UI and the Updates card (§15.7.1) are built and land in the release
after v0.13.0.

### 15.1 Browse

- Header: search field, **Sources** button, **Add** menu (Add marketplace…,
  Install from Git URL or folder…, Add MCP server…), source filter chips (All sources +
  one per enabled source).
- Kind tabs: Plugins, MCP, Skills, Agents, Themes, Fonts, Languages,
  Providers, Messaging — each with a count.
- Card: icon, display name, one-line description, **source badge**
  (`Ave Official` with a shield glyph; managed sources with a building glyph
  and their label; custom sources their id), version, state chip: `Install`,
  `Installed`, `Update 1.4.2`, `Requires Ave 0.12`, `Yanked`,
  `Installed from <other source>`, `Source removed`, `Required by your
  organization` (no Uninstall or Disable control; the tooltip names the
  policy file). The card also shows its source's badges (§15.4).
- Same name in two sources: two cards, each with its own badge. No merged row.
  Installing the second one is a source switch (`PACKAGE_ID_CONFLICT` explains
  it and offers the switch). The switch keeps the plugin's data directory, so
  the consent text says that the new source's code receives the data the
  installed plugin stored. Before the app moved to the git marketplace, the
  signed catalog never replaced a git-bound plugin (install, update or
  rollback): the user updated or rolled back through the bound source, or
  uninstalled first.
- The boot-install notice (§10.2) appears once as a banner listing what was
  installed or updated, split into "Installed for you" (default, with
  Uninstall) and "Required by your organization".

### 15.2 Package detail (sheet)

Sections: overview; **Provenance** (source, repository — or the folder of a
folder source — path, commit short SHA with the full SHA in a tooltip and a
copy button, published date);
**Compatibility** (`minAppVersion` and verdict); **Permissions** (from the
descriptor's authority, before any download); **Delivery** (the rung list with
the rung that will be used; a plain-http release or archive says
"unencrypted download — verified by the pinned sha256"; a folder plugin's one
rung is "Built tree in the folder"); **Versions** (history
with yanked and incompatible markers).

A package from a folder:
- **Provenance** rows *Folder* (folder glyph), *Path* (the canonical path),
  *Read* (relative time, the absolute time in a tooltip) and *Contents* (the
  first 12 characters of the tree digest, all of it in a tooltip), in place
  of repository, path and commit.
- **Versions** says "Only the version in the folder can be installed" and
  offers no other version to install. A descriptor without a version shows
  the synthesized `0.0.0+t<digest12>` (§8.2), and any change to its files is
  an update.
- **Delivery**'s help says the folder's built files install as they are,
  nothing is downloaded or built, and a declared release is not used; the
  folder rung shows no sha256 line.
- The **review** names the folder's contents it is bound to ("Bound to the
  folder's contents <revision 7>") instead of a commit, and lists the plan's
  `notInstalled` entries: "Left out of the install (an extension from a
  folder installs plugin.json, dist/ and assets/ only): …".

A failed install that the source can allow (§14) offers *Allow…*. For a
catalog that names another internal host, the button is *Allow internal
downloads*. For sign-in held back over http, the credential risk is stated
beside the button. It calls `sources:acknowledge`, then plans again. A plan that
expired because the policy changed (`PLAN_EXPIRED` `policy-changed`) offers
*Review again*, which makes a fresh plan.

### 15.3 Install progress

Inline in the sheet: rung rows with `skipped`/`failed`/`using` and a progress
bar for downloads; then the existing permission-review step; then result. A
failure shows every rung's reason and a copyable diagnostic.

### 15.4 Sources

Table: source (label, URL or a folder source's path, origin badge), pinned
commit or contents (short SHA with tooltip, relative time of last sync),
package count, status (`Up to date`,
`Syncing`, `Auth required`, `History rewritten — review`, and for any other
failed sync a chip by its code: `Unreachable` only when the host was not
reached, else `Repository not found`, `No marketplace found`, `Branch or tag
not found`, `Marketplace index invalid`, `SSH host key not verified`,
`Blocked by policy`, `Address refused`, `Needs your confirmation`, `Git
unavailable`, for a folder source `Folder not found`, `Folder moved` or
`Folder unreadable`, or `Update failed` for any other code; each adds `— showing
cached` while the pinned snapshot is served) with, under an unreachable or
auth-required status, the failure's sentence from its stored detail (§14),
enabled switch, overflow (Refresh, Set token, Remove). Official and managed
rows have no Remove; the official switch is locked unless policy allows;
managed rows show a lock.

- **Badges** sit on the row and on its package cards. Each has a text label
  and a tooltip, never colour alone:
  - *Unencrypted (http)*, while the source is http;
  - *Internal network*, *This computer* and *Internal downloads*, for each
    confirmation held.

  The http tooltip: "Anyone on the network path can read what this source
  sends and change what it serves. Updates from it are not installed
  automatically."
- **Allow…** appears when the last sync failed for a confirmation the
  source can hold (§14). It asks the warning's question, then calls
  `sources:acknowledge` and syncs again. For sign-in held back over http
  (`SOURCE_AUTH_REQUIRED` `token-unencrypted`) the question is the full
  `token-unencrypted` warning, that the sign-in travels unencrypted and
  anyone on the network path could copy it, as on *Set token…*
  (`allowRisk`, `labels.ts`).
- **Set token… on an http source** first asks for `token-unencrypted`, unless
  the source already holds it.
- **A folder row** shows a folder glyph, "Folder" and the path, truncated in
  the middle with the full path in a tooltip; the path wraps rather than
  widening the table. The commit cell reads `folder · <revision 7>` (the
  revision without its `local-` prefix), and "read <time>" while the status
  is *Up to date* — never after a failed read. The badge is *Local folder*
  or *Network folder*, with a tooltip saying the folder is read in place and
  when changes are picked up. Its overflow has *Refresh*, *Show in Finder*
  (macOS) / *Show in Explorer* (Windows) / *Show in file manager*
  (`sources:reveal`), and *Remove*; it has no *Set token*. A folder that was
  replaced or recreated at the same path says so ("<path> is no longer the
  folder that was added …") rather than naming the path twice, and a
  failed *Show in …* gives the failure's sentence on the row.

### 15.5 Add marketplace dialog

Step 1: URL field (accepts `owner/repo`, and a folder path or `file:` URL,
§7.7) with *Choose folder…* beside it, optional ref, auth radio (None /
Token / SSH). *Choose folder…* opens main's folder dialog
(`sources:pick-folder`), fills the field with the chosen path as the tab
may show it (scrubbed, §18.8) and checks the chosen folder at once by its
pick; editing the field makes it typed text again; cancelling
changes nothing, and a dialog that could not open says to type the path
instead. Input that looks like a folder hides the ref, package-folder and
sign-in fields and says a folder is read as it is; a relative path is
refused with a sentence that says to enter the full path or use *Choose
folder…*. A folder needs no git: while git is missing, the git step offers
*Choose folder…* ("Adding a folder does not need git") and a folder's
address can still be checked. A folder on another computer asks
`network-folder` in the same confirm step. A folder refused because it is,
lies inside or contains a folder source already added (`SOURCE_ID_TAKEN`
`folder-already-added`, `folder-inside-source`, `folder-contains-source`,
§18.8) says which, and offers *Show <id>*: it closes the dialog, opens
Sources and marks that source's row (background colour, brought into view)
until the view changes. A taken id without such a source offers no button.
When the address needs confirmations (§7.2 step 2), a
confirm step comes before any traffic. It shows "Before Ave connects" and
one question per warning, in the warning tone (*Cancel* / *Continue*).
*Continue* previews again with them. Changing any field drops the
confirmations given. Each answer belongs to the fields as they were when it
was asked: an edit, a newer check or reopening the dialog drops any answer
still on its way, so a late warning for an earlier address is never shown or
confirmed for the new one. Opening or closing the dialog also ends the wait
for that answer, so a reopened dialog can check its address at once. An
add that finishes after its dialog was closed, or reopened for another
address, still refreshes the source lists, but it neither closes the dialog
now showing nor opens a package sheet.

Step 2 (preview):
- marketplace name, owner, commit, and counts per kind;
- the source's badges;
- the warning "N packages can run code on this computer";
- a note when an OS credential helper will answer for this host;
- diagnostics;
- the id field.

For a folder the preview first shows *Folder <path>* (the canonical path),
and when the walk followed a link, "You entered <input>. A link on that path
leads here, so Ave reads this folder." It shows *Contents <revision 7>* in
place of the commit and "Changes in this folder are picked up at start-up,
every few hours and on Refresh." A direct folder without a version in its
descriptor adds that the folder's contents name the version and any change
to its files counts as an update.

Confirm button: **Add marketplace**. If the input is a single package, step 2 switches
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

### 15.7.1 Updates card

A card in Settings → Marketplace → Maintenance, above the Git runtime card
(`UpdatesCard.tsx`), read from `updates:status` and then
`marketplace:update-status`:

- "Checks for updates at start-up and once a day · last checked <time> ·
  next <time>" (last checked is the last successful discovery);
- *Check now* (`updates:check`), disabled while a check runs;
- the last result when it was not `ok`: offline ("Offline — last checked
  <time>. Ave checks again when the network is back."), partial (some
  sources were not reached, with *Show sources*, where each row says why,
  §15.4), or a check that could not finish; and a lost `updates.json`;
- each update with its version change and its state (§18.7.5); `manual` and
  `needs-review` rows offer *Review*, which opens the update review (§15.6).
  A `stale` row adds "Source not reached in the last check — shown as an
  earlier check left it." After an `ok` check with nothing listed, the card
  reads "No updates to review." — never "up to date", since a skipped
  version is left out of the list;
- when the scheduler does not answer, "Update checks are not available
  right now. Restart Ave; if it persists, use Copy details to report it.",
  with main's message only behind *Copy details*, scrubbed (§18.8).

The card is read-only: the automatic-update switches and the recent
automatic updates arrive with automatic apply (§18.9). The toolbar pill
(`PluginUpdatesPill.tsx`) counts only the updates that need the user
(`updateNeedsUser`, §13.1), whatever else it is sent.

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
| the fourteen compiled theme bundles outside `moonstone` and `gallery` (`theme/bundles/*.ts`, their `styles.css` blocks, `MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS`) | removed; the official theme packages carry the same ids |
| vendor ids `nousResearch`, `v0` | renamed `nous-research`, `vercel-v0` with a one-time settings and secret migration, because a provider package is named after its vendor id |
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
  asset and pinned by its sha256 when the official repository is seeded. "Every version" means
  every version the app can load: a release from before the Agent Plugins
  manifest (the lines below `minAppVersion` 0.7.0, whose `plugin.json` has
  no `extensions["ai.agent-connector.ave"]`) fails `parsePluginJson` before and after the
  switch, so it has no working grant to keep and is not pinned. An entry
  with no matching pin loses the grant until it updates, and the boot notice
  says which plugin lost which key.
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

### 16.4 As built

Where the sections above and the shipped code differ, the code wins:

- **The lock names a source (§10.2).** A `requiredInstalls` entry locks the
  package installed from the source the entry names, and nothing else: a
  package with the same kind and name bound to another source, or to none,
  can be uninstalled and disabled. The Plugins tab (`PluginDeploymentGuard`)
  and the marketplace's uninstall apply the same rule, reading the policy
  file at each check; a policy file that cannot be read locks nothing. The
  deployment guard has no actor model any more, and there are no
  administrator installs: the first boot turns `installSource: "admin"` into
  `user` (§16.3), so a required install that finds its package bound to
  another source performs an ordinary source switch.
- **Retired manifest fields (§5.3).** The loader drops both `installPolicy`
  and `publisher` before schema validation, with one warning per plugin;
  git staging and the repository check reject a manifest that carries
  either, by name.
- **Revocations (§10.4)** are enforced at boot and again after every
  background sync, not only at boot; each revoked install is reported once
  per session. An install in progress is fed to the registry under the
  source it is being installed from, so switching a package's source never
  leaves it judged by the old source's revocations or by none. A pinned
  snapshot whose file is missing is an error, not an empty feed.
- **`update-condition.ts`** held only the managed update kinds and is
  deleted; `update-detector.ts` stays.
- **Local marketplaces in development (§16.2).** An unpackaged build started
  with `AVE_DEV=1` may reach a marketplace over plain HTTP on loopback — an
  author's checkout served by `git http-backend`, or the end-to-end test's
  fixture. The file protocol stays refused, so a local directory is served
  over loopback rather than registered as a direct source.
- **End-to-end test (§17).** `test/e2e/ui/git-marketplace-lifecycle.spec.ts`
  replaces `marketplace-e2e.yml` and runs with every other Playwright spec in
  the nightly `e2e.yml`. MCP governance still decides whether a marketplace
  MCP server may be configured (§13, `PACKAGE_POLICY_BLOCKED`), so the spec
  writes a governance policy approving its server into the run's
  `AVE_HOME`, as an organization would.
- **Removed with the server stack, beyond §16.2:** the Doctor's server-install
  cleanup action, the synthetic install-failure cards, the
  `plugins.installProgress` channel (nothing emitted it), the unrendered
  plugin grid and its web-store link, and the server-era artifact stores.
  Boot removes what that stack left on disk: the admission, whitelist and
  revocation documents, the catalog cache, and each package tree's tarball
  cache and verified downloads. `AVE_ADMISSION_OFFLINE` is scrubbed from the
  environment like the other retired variables.
- **First-boot migration (§16.3)** runs once the official source has a
  snapshot, and records itself in `packages/legacy-migration.json`: `{
  version: 1, completedAt }` when every entry migrated, otherwise `{ version:
  1, reportedUnmanaged }`, and the next run tries again without naming an
  unmanaged entry a second time.
- **Language keys across app versions.** The upgrade run found every
  installed language breaking on the first boot of a build whose catalog
  had lost keys (the switch removes 157). A key outside the interface set is
  now ignored on a device and refused only by the repository check (§5.5).
- **Web documentation.** The site's server-marketplace pages and their
  twelve screenshots are gone; `/docs/marketplace` explains sources, installs
  and updates, and `/docs/marketplace/authors` is the package-author page
  (both in Korean and English). The pages that described a marketplace
  account, an install deeplink by slug or a publisher signature now describe
  the git marketplace.

## 17. Test plan

The tests of §18's slices are listed with each slice of §18.10.

| Layer | What proves it |
|---|---|
| Schemas | fixture sets for every kind: valid, each invalid rule, unknown keys; a manifest with `installPolicy` is rejected by name at install and in the index CI; an installed legacy manifest with it loads with one warning |
| Version choice | table tests for `minAppVersion`, yank, platform, pre-release opt-in, rollout buckets, per-source revocations |
| Ladder | each rung used/skipped/failed combination, mismatch of each authority field stops the ladder, plan binds commits, receipts carry rung outcomes |
| Git runtime | fake `git` binaries for version gates (2.45.0 refused, 2.45.1 accepted); env/flag/global-config contract; askpass ticket host binding; managed install with a local fixture server and wrong-hash rejection |
| Update scheduler | fake time (`background.test.ts`): an offline discovery retried an hour later, not an interval later; an offline *Check now* after a recent success retried an hour later; a success not repeated for the interval; the apply check at boot and 24 hours after the last; at exactly 24 hours, and phased apart from discovery, the apply check discovers before it classifies; a due apply check joins a discovery in flight and, after a partial one, classifies only the reached sources and stays due; `resume` after a 30-hour clock jump runs a discovery; *Check now* answers when its discovery and classification end; a successful check that spans a sleep is timed at its end; only reached sources are published, an unreached one's update only as an earlier discovery showed it, `stale`, in the status and the `updates-available` event; a discovery that throws turns what was shown stale and classifies nothing cached since; a stop at any wait of the boot pass, a recheck, *Check now* or a due apply check — the wait then fulfilling or rejecting — publishes, writes, logs, starts and arms nothing more (one table over every wait; `service.test.ts` runs it over the real service, held at its sync and its enforcements, and over the real syncer and installers, held in a sync's pruning and a boot content install, and finds no further progress, stage, publication, write or event of any kind through the boundary, while the install and its record finish; an enforcement queued behind another is cancelled when its signal aborts), and an unreadable file is left as it is, unreported, when the stop comes before its read ends; `git-marketplace.test.ts`: after the stop, Retry and Check now answer with their declared refusals, and a plugin install that lands after the shutdown hook finishes without `plugin.installed` or a bridge refresh; `git-runtime.test.ts`: runtime progress stops at the marketplace's shutdown hook; `ave-deep-link.test.ts`: a marketplace link is refused once the lifetime has ended; an unreadable `updates.json` sets `historyReset`. `history.test.ts`: the file's strict shape and the due rules. `service.test.ts`: `ok`, `partial` and `offline`, and a broken source with every other one offline is `partial`. `PluginUpdatesPill.test.tsx`: only states that need the user are counted. `GitMarketplaceTab.test.tsx`: the card's states, "No updates to review", a `stale` row, and an unanswered scheduler in its own words with main's message only behind *Copy details* |
| Sync | local bare repos: fast-forward with the pin far behind the tip, rewrite (official and managed refuse, custom review), invalid index keeps pin, mirror fallback, a hidden source with installed packages still syncs |
| Network gate | normalization equivalences (scp/ssh/https, case, `.git`); `<helper>::` transports and credentials in a URL refused; block beats allow; `requireHttps` and `blockPrivateNetworks` block acknowledged sources; each address class for entered and catalog-supplied targets (`198.18.0.0/15` is internal, metadata is refused for a listed host, a loopback download on another port is refused, `internal-network` does not imply `internal-downloads`, a listing never implies `token-unencrypted`); redirect to a blocked host refused; no auth header across hosts |
| Connection binding (§7.4) | `pinned-fetch.test.ts` against real local servers: one lookup per hop, a connection to the checked answer only, a metadata answer dropped, each PAC kind (`PROXY` with an http and an https target, `HTTPS`, `SOCKS5`, `SOCKS4`, an unknown kind failing `proxy`), no fallback to `DIRECT`, literal metadata and unroutable proxies refused without a lookup, certificate checks against the name, every TLS connection (target and `HTTPS` proxy) asking for verification and the hostname itself, and no TLS connection for a plain http request; `network-gate.test.ts`: a sign-in never carried onto an http hop, even to the host the https request went to; `run-git.test.ts` also: literal proxies refused before git starts (IPv4, IPv6, mapped, NAT64), and one PAC answer per call configuring and binding the same route; `trusted-proxy.test.ts` pins the proxy boundary; `run-git.test.ts`: the `http.curloptResolve` pin, no git started when only refused answers remain, no credential over http without `token-unencrypted` (a stored token on a listed host included), and end to end from the gate's verdict: an http source asked for before any lookup, reached only at its checked address with `unencrypted`, signed in only with `token-unencrypted` too; `ssh-preflight.test.ts`: the preflight before git, any refused answer fails, no lookup behind `proxyjump`, and the stated residual |
| Confirmations and policy refresh | `service.test.ts`: a preview that needs a confirmation answers `confirm` with no git command and no lookup; *Add* stores exactly the carried confirmations; a host whose lookup finds an internal address asks, and *Allow…* syncs it; rewriting the policy file blocks the next preview and expires an existing plan with `policy-changed`; an invalid file, then a fixed one, goes official-only and back; with every refresh overlapping the next operation, each operation runs under the policy on disk (strict: no git preflight) and a malformed or unreadable file fails all of them closed with one warning; an operation that began after the file went strict again runs strict though an older refresh read it permissive; operations that keep arriving see a change within the one queued refresh; the update check a catalog change starts, and work left running after an operation, read a policy changed meanwhile; the real scheduler's update check, asked for by a sync's published snapshot while that sync's operation is still open, refreshes the policy itself and offers no update from a source the policy dropped meanwhile; `background.test.ts`: every scheduler entry runs outside the caller's async context; `alert-predecessor.test.ts`: predecessor removal and an install both finish when the policy changes while one holds the plugin locks and the other waits for one (real locks, bounded); `policy.test.ts`: a same-size same-mtime rewrite and a permission change are noticed, an http `additional` source is its own listing; `registry.test.ts`: confirmations are dropped when a managed entry or `sources.json` points the source at another address; `network-gate.test.ts`: listing `127.0.0.1` lets no other catalog reach another local port; UI: a late preview answer is dropped after an edit, a dialog reopened during a check can check at once, an earlier add that finishes leaves a dialog reopened for another address open (the lists still refresh), and Allow… for sign-in over http states the credential risk |
| No privileges | a custom package with the same name as a granted plugin gets no grant; a grant fails for a different artifact hash, for a tree-rung install and for a swapped manifest; a legacy entry keeps the grant only with a matching receipt hash; a source's revocation ignores other sources' packages; no package can block its own uninstall; a manifest carrying `installPolicy` is rejected at install |
| Default and required installs | default: installed once through the ladder, never reinstalled after uninstall; required: reinstalled and updated at boot, uninstall and disable denied with `PACKAGE_REQUIRED_BY_POLICY`, becomes a user install when the entry is removed; both lists limited to official/managed sources; migration marks former admin installs as applied and unlocks unmatched entries |
| Identity | reserved names, same `(kind, name)` across sources, `PACKAGE_ID_CONFLICT`, update binding, source switch keeps plugin data |
| Direct install | each detection branch; `server.json` mapping for npm/pypi/oci/remote; `folder-direct.test.ts`: a direct folder's synthesized `0.0.0+t…` version, which changes with its files, and `allowDirectInstall: false` refusing it at the preview (a marketplace folder still previews), the add and the plan |
| Local folders (§7.7) | `source-input.test.ts` under `path.posix` and `path.win32` rules: every accepted folder form normalizes and every refused form names its reason, and `a/b` stays the GitHub shorthand. With the recording volume of `fixtures/folder-fs.ts` (every call logged): `folder-consent.test.ts` — a UNC path answers `confirm` with no call at all and a share-mapped drive with only `queryDosDevice`, the same inputs under `allowLocalSources: false` are blocked with none, an acknowledged folder is read with no call outside the reader's own (no `realpath`), `/tmp → private/tmp` and a root that is itself a link resolve, an ancestor link to `\\attacker\share` is `link-to-network` with no call on it, a block found only on the canonical path ends the preview before a file is opened, a Windows 8.3 short name is spelled by its long name, a relative link onto an automount path is `link-to-network` (confirmed or not) with no call under it, another spelling of an automount path, components after a local link that reach one, and a canonical path holding the automount roots each answer `confirm` before it is touched, a drive with no mapping warns and a classifier that cannot run is `classifier-unavailable`; `git-marketplace.test.ts` (IPC) carries `classifier-unavailable` and the `folder-*` reasons of `SOURCE_ID_TAKEN` across the envelope and renders them in English and Korean; `folder-real-fs.test.ts` on the machine's own filesystem (run on macOS and on Windows) — a network path answered before any call, a link inside (a junction on Windows) read and one leaving the folder refused unread, a directory reached twice a loop, the volume's own case rule, a link into `.git` refused with nothing beneath it touched, and a hard link read as a regular file; `folder-tree.test.ts` — an inside link reads as a file, an outside link and a link chain or junction to a share stop at their text with no call on the target, a mapped network drive by its mapping, a loop, an `fstat` mismatch, an ancestor swap kept in place (`changed-during-read`, no outside byte in the package) and the stated residual of one undone before the recheck, the skip list, a link into a skipped entry (also as `.GIT` or an 8.3 alias) as `link-to-skipped` and an index path naming one as absent, an automount path beneath an unconfirmed root stopped before it is touched, a relative link from a confirmed share to another server as `link-to-network`, NFD/NFC and collisions, special files, a plugin's left-out entries; `folder-identity.test.ts` — a case-sensitive volume keeps two spellings as two sources, an `allow` `path:` admits only its spelling and a `block` every spelling, a case-insensitive volume and an aliased directory are one source by on-disk spelling and `dev`/`ino`, nesting is refused, by path and through an alias in both orders; `folder-sync.test.ts` — editing a `SKILL.md` changes the revision, no git command and no download run, only the folder's version is offered, a background `permission` failure keeps its reason through a reload and renders, a stored path now leading elsewhere is `moved` without reading the target, a broken classifier is `classifier-unavailable` with nothing read and renders as reinstall advice after a reload; `folder-plan.test.ts` — a plugin file and a `SKILL.md` edited between plan and execute install the planned bytes, a declared release is never fetched, the executable bit survives, a `process` entry is refused with `process-entry-requires-pinned-artifact`, a folder with no `plugin.json` is `folder-has-no-build`, and the capture is deleted; `plugin-ladder.test.ts` — a git tree with `src/` still fails the tree rung; `policy.test.ts` — `allowLocalSources`, an `allow` list without `path:`, `path:` prefixes and Windows spellings, `path:` and git patterns kept apart, and `additional[].path` with its refusals; `registry.test.ts` — a folder entry and its identity (with its ancestors) round-trip, confirmations bound to the path and dropped for any other spelling of it, the pin paired with the transport, a managed folder holding `network-folder`; `windows-path-kind-launcher.test.ts` (exit 1 is "no mapping"; a missing, unstartable, timed-out or off-protocol helper rejects with its cause and what to do) and, on Windows, `scripts/test-windows-path-kind.mjs` (CI step *Verify Windows folder classification*): `C:` maps to a volume, a `subst` drive (and a `subst` of one) to its target, and an unused or removed drive fails closed |
| Folder UI (§7.7, §15) | `folder-view.test.ts` with the same volumes — *Local folder* on a folder's preview, row and package cards and *Network folder* on an acknowledged share, the provenance `{ path, readAt, contents }`, `revealFolder` answering a folder's path, `null` for git and `SOURCE_ID_INVALID` for an unknown id, a deleted folder `not-found`, a path relinked elsewhere `moved`, and a drive remapped to a share refused with only `queryDosDevice` called; a classifier that cannot run marking only its row and cards `folder-unclassified` (and asked again once it runs), a share the source never allowed `network-folder-unconfirmed`, a directory recreated at the path `moved` on reveal as on refresh, and a remap during reveal's walk refused by its last classification; `git-marketplace.test.ts` (IPC) — `pick-folder` `null` on cancel and `{ pick, display }` on choose without building the service, a pick previewing and adding the folder main chose and never the sibling its masked display names, a forged, replaced, used or expired pick `folder-pick-unknown`, a package from a quarantined source refused detail but uninstalled by its handle with the source listed and removed, both channels refused to a plugin frame, `reveal` refusing a git source and an unknown id before the shell is asked, and a drive whose classifier cannot run with `classifier-unavailable` and the reinstall sentence, nothing shown; `SourcesAndAdd.test.tsx` — the folder row (path, `folder · rev`, read time, *Show in …* per platform, no *Set token*), the moved and replaced sentences, *Choose folder…* with `resolvedFrom`, a cancelled and a failed picker, the folder hiding ref and sign-in, the `network-folder` question, the relative-path sentence, a folder added while git is missing, `classifier-unavailable` on the preview, the row status and a failed *Show in …*, the three overlap sentences and `repository-already-added` each with *Show <id>* and none for a bare taken id, the marked row brought into view; `GitMarketplaceTab.test.tsx` — a folder package's badge, provenance, versions note, delivery help, `notInstalled` and the folder-bound review, *Show <id>* closing the dialog and marking the row on Sources until the view changes; E2E (`git-marketplace-lifecycle.spec.ts`, folder dialog and shell stubbed in main) — add a folder marketplace through *Choose folder…*, install a skill, edit it, *Refresh*, *Show in Finder* gets the source's path, and the catalog offers the update |
| Service | `former-service.json` parsing, `movedTo` with and without `movedFrom`, reset on build-constant change, policy override, announcements parity, label fallback |
| E2E | packaged dev build (loopback allowed by the dev flag) adds a local-HTTP git marketplace, installs one package of each kind, updates, removes the source; without the dev flag, the same kind of source asks for `unencrypted` and `this-computer` before the fixture server sees any request, and the preview, cards and Sources row show the badges |

## 18. Source acceptance, local folders and automatic updates (after 0.13.0)

> Status: **Designed** 2026-10-01, first for app release 0.13.0. 0.13.0
> shipped with slice B only; slices C and E land in the next release, and the
> later slices after it. Where this section says 0.13.0, read the release that
> carries the slice.
> - Slice B (messages), slice C (target classes, warnings and connection
>   binding), slice E (discovery and status), slice D1 (folder sources:
>   engine and consent) and slice D2 (folder sources: dialogs and
>   presentation) are built. §7, §12–§15 and §17 describe them as
>   built: §7.4 for the classes, outcomes and binding of §18.2, §18.3 #1–4
>   and #7, and §18.5, §12 for `requireHttps`, `blockPrivateNetworks` and the
>   policy refresh of §18.6, §7.3 and §15.7.1 for the update scheduler,
>   `updates.json` and the Updates card of §18.7.1 and §18.9, and §7.7, §8,
>   §12, §13, §13.1, §14 and §15 for the folders of §18.3 #5–6, §18.4, the
>   folder keys of §18.6 and the folder channels of §18.9.
> - The rest (automatic apply and what its settings decide, slice F) is not
>   built. Where this section and an earlier one
>   disagree, the earlier section describes the build and this section the
>   target.
> - Each slice of §18.10 rewrites the owning section in the same change and
>   removes its pointer here. Code is cited at `e10c823e2`.

### 18.1 Owner decisions (2026-09-28, closed)

1. Plain `http://` git sources and local folders are accepted, as
   marketplaces and as direct packages, so that no ordinary way of hosting a
   marketplace leaves the user asking why it does not work.
2. The address guard warns instead of refusing, except where no decision by
   the user can make a target safe (§18.3).
3. Installed packages update automatically. The app checks for updates at
   boot and once a day.
4. Consent is never bypassed: an update that changes what runs, or what it may
   reach, waits for the user.
5. Administrators keep the strict behaviour through managed policy (§18.6).

### 18.2 Outcomes, and who chose the target

> Built in slice C for git and downloads; §7.4 describes it as built.
> `network-folder` is built in slice D1 (§7.7); `unencrypted-updates`
> belongs to slice F.

| Outcome | Meaning | Who can change it | UI tone |
|---|---|---|---|
| **Accept** | proceed | — | none |
| **Warn** | proceed after one confirmation, stored on the source and shown as a badge while it applies (§18.5) | the user | amber; *Continue* / *Cancel* |
| **Refuse** | never done; no confirmation exists (§18.3) | an app release | red; no *Continue* |
| **Policy block** | the system policy file forbids it (§18.6) | the administrator | lock glyph, "Set by your organization"; no *Continue* |

- **Entered** targets: what the user typed, pasted or picked (Add dialog,
  *Install from Git URL or folder…*, a deep link once the dialog shows it),
  plus the official source's build constant and a managed source's policy
  entry.
- **Catalog-supplied** targets: what a marketplace's files name —
  `artifact.release.url`, `artifact.archive.url`, the derived release URL of
  §6.2 — and every redirect hop of a download. A third party wrote them and
  the user does not see them before the request.

#### 18.2.1 Address classes

One new function, `classifyAddress(address)`, exported from
`src/core/network-guard.ts` beside `isGloballyRoutableAddress` (`:257`),
classifies each address. A name that resolves to several addresses takes the
most restrictive class for warnings; which answers may be connected to is
§18.2.4's rule. IPv4-mapped IPv6 and NAT64 (`64:ff9b::/96`) take the class of
the embedded IPv4 address, as today.

| Class | Addresses |
|---|---|
| `public` | `isGloballyRoutableAddress` is true |
| `internal` | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, `100.64.0.0/10`, and `198.18.0.0/15` (fake-IP proxy tools answer every name from this block) — minus the two metadata addresses below |
| `this-computer` | `127.0.0.0/8`, `::1`, `0.0.0.0/8`, `::` |
| `metadata` | `169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `100.100.100.200` |
| `unroutable` | every other special-purpose block of `network-guard.ts:116-150` (documentation, multicast, reserved, broadcast, protocol assignments) |

As built, a separate `fetchAddressCheckedResponse(url, { addressPolicy,
fetchImpl })` takes `addressPolicy(address, hop) => "allow" |
NetworkGuardError` in place of the three `allow*` axes. It shares the redirect
loop with `fetchPublicHttpResponse`, whose signature is unchanged. Only the
marketplace gate calls it; every other caller keeps today's behaviour.

#### 18.2.2 Entered targets

| Target | Outcome |
|---|---|
| `https` or `ssh`, `public` | accept |
| `internal` | warn `internal-network` |
| `this-computer` | warn `this-computer` |
| scheme `http` | warn `unencrypted`, in addition to the address class |
| `http` with token sign-in, or with an OS credential helper that answers for the host (§9.3) | warn `token-unencrypted`, in addition |
| network folder (§18.4.1 step 3) | warn `network-folder` |
| `metadata`, `unroutable` | refuse (§18.3) |

- A host the policy lists (`allowHttpHosts`, an `allow` pattern, an
  `additional` source; §12) is accepted without the `unencrypted`,
  `internal-network` and `this-computer` warnings. `metadata` stays refused
  for it, as §12 already says. **`token-unencrypted` is never implied by a
  listing**: the policy authorizes the transport, not sending the user's
  credentials over it.
- An unpackaged build started with `AVE_DEV=1` accepts `this-computer`, and
  plain http to it, without a warning (§16.4), so E2E fixtures need no
  confirmation for the source itself. `unencrypted-updates` (§18.7.2) is not
  exempted.
- **Credentials over http**, one rule for every source origin, managed
  included:
  - Askpass (§9.3) answers for an `http` remote only when the source holds
    `token-unencrypted`.
  - Every call on an `http` remote without it carries `-c credential.helper=`,
    so an OS helper never sends a stored password in the clear.
  - A stored token on an http source without it is not offered; the sync
    fails `SOURCE_AUTH_REQUIRED` reason `token-unencrypted`, and the row
    offers *Allow…* for that warning.
  - *Set token* on an http source asks for `token-unencrypted` before it
    stores the token.
  - The preview of an http source that answers 401 asks for
    `token-unencrypted` before any credential is sent.

#### 18.2.3 Catalog-supplied targets

| Target | Outcome |
|---|---|
| `public`, `https` | accept |
| `public`, `http` | accept; the Delivery row (§15.2) says "unencrypted download — verified by the pinned sha256". The pin comes from the source over the source's own transport, and a rung without a pin is skipped (§6.2) |
| the source's own host (same normalized host; for `this-computer` also the same port; an ssh source's derived `https://<host>` counts) | inherits the source's confirmations |
| `internal`, another host | accept only when the source holds `internal-downloads`; otherwise the rung fails with `SOURCE_CONFIRMATION_REQUIRED` naming the host, and the Sources row offers *Allow internal downloads*. `internal-network` does **not** imply it: confirming that a source is an expected internal server says nothing about the other hosts its catalog may name |
| `this-computer`, another host or port | refuse (§18.3 #4) |
| `metadata`, `unroutable` | refuse (§18.3) |

Rung semantics are unchanged (§6.2): a failed rung is recorded and the ladder
moves on.

#### 18.2.4 Binding the check to the connection

A refusal or policy block that depends on the resolved address (§18.3 #3 and
#4, `blockPrivateNetworks`) is enforced on the address the connection
actually uses. Enforcement on the connected address applies to the
transports Ave owns (downloads, git over http/https). For SSH it is a
preflight check only (git over ssh, below). Today the check and the
connection are separate: `ensurePublicHttpUrl` resolves, then
`fetchPublicHttpResponse` hands the hostname to the Chromium transport
(`network-guard.ts:435-455`, `boot/steps/desktop-network-fetch.ts:79`), and
git resolves the remote itself, so a name that answers a public address to
the check and a loopback or metadata address to the connection passes.
Warnings are advisory and may stay checked at add time; refusals and policy
blocks may not.

- **One lookup per connection.** Each connection Ave owns resolves the
  host once with `dns.lookup(host, { all: true, verbatim: true })`, classifies
  every answer, drops the answers a refusal or policy block forbids, and
  connects only to the remaining answers. No answer left → the refusal of the
  most restrictive dropped class. A remaining answer whose class needs a
  confirmation the source lacks → `SOURCE_CONFIRMATION_REQUIRED` (§18.5).
- **http downloads** (`MarketplaceNetworkGate.fetch`,
  `network-gate.ts:138-172`). The Chromium transport has no hook between
  resolution and connection, so marketplace downloads move to a new pinned
  transport, `src/marketplace/net/pinned-fetch.ts`, built on the host's
  existing pinned-connection pattern, `createA2AStrictTransport`
  (`src/api/a2a-remote-transport.ts:74-232`). It resolves once, checks every
  answer (`:102-106`), connects with a `lookup` that returns only the chosen
  answer and fails a second call (`:135-142`), and keeps the hostname for SNI
  and certificate checks (`servername`, `:131`). Its trust store is
  `tls.getCACertificates("default")` plus `tls.getCACertificates("system")`,
  so a company root installed in the OS store keeps working (§9.2). Electron
  44 ships Node 24.20.0, which has both. Each redirect hop is a new
  connection with its own lookup and checks.
- **Proxies on the transports Ave owns are trusted beyond their socket.**
  When PAC routes a download or a git http(s) connection through an http(s)
  or SOCKS proxy, local or remote, Ave owns the socket to the proxy: it
  checks the proxy's own address, connects only to it, and **trusts the
  proxy to enforce destination restrictions** beyond it. Ave does not see
  the address the proxy connects to. A proxy on this computer
  (`PROXY 127.0.0.1:8080`) connects from this computer, so a catalog-chosen
  name it resolves to loopback or to the metadata endpoint reaches those
  targets. The refusals and blocks that depend on the resolved address
  (§18.3 #3 and #4, `blockPrivateNetworks`) hold for direct connections and
  for proxies that resolve locally, and not beyond a proxy that resolves
  the target itself. This is the stated boundary.
- **ssh `ProxyCommand` and `ProxyJump`** are executed by ssh. Ave neither
  inspects nor binds them: it does not check the command, the jump host or
  their addresses, and it does not see where they connect. They are trusted
  like any program the user configured. There is no first-hop guarantee.
- **Proxies for downloads.** The route comes from the session's
  `resolveProxy(url)`, the resolver git already uses (`run-git.ts:199-211`).
  Only its first entry is used: a fallback to `DIRECT` is never taken
  silently. The proxy host is resolved and checked as above (`metadata` and
  `unroutable` refused; `internal` and `this-computer` accepted, because the
  system configuration chose them). The transport supports the kinds the
  host already maps for subprocesses (`PROXY`, `HTTPS`, `SOCKS5`,
  `src/shared/pac-proxy.ts:14-16`), plus `SOCKS`/`SOCKS4`, which git already
  accepts (`run-git.ts:205-208`):

  | PAC kind | Connection Ave makes and checks | Target resolution | TLS to an https target |
  |---|---|---|---|
  | `DIRECT` | the target's checked answer, pinned | this computer, checked | end to end, `servername` = target host |
  | `PROXY host:port` | TCP to the checked proxy address; `CONNECT host:port` for https, an absolute-form request for http | the proxy (trusted) | inside the `CONNECT` tunnel, `servername` = target host, verified with the same CA set |
  | `HTTPS host:port` | TLS to the checked proxy address (`servername` = proxy host, same CA set), then as `PROXY` inside it | the proxy (trusted) | a second TLS session inside the tunnel, `servername` = target host |
  | `SOCKS5 host:port` | TCP to the checked proxy address; SOCKS5 `CONNECT` with the domain-name address type | the proxy (trusted) | inside the tunnel, `servername` = target host |
  | `SOCKS host:port`, `SOCKS4 host:port` | TCP to the checked proxy address; SOCKS4 `CONNECT` carrying the target's checked IPv4 answer (SOCKS4 carries only an IPv4 address) | this computer, checked and pinned; no IPv4 answer → `SOURCE_UNREACHABLE` reason `dns` | inside the tunnel, `servername` = target host |

  Any other kind (one only Chromium's own stack speaks, such as `QUIC`) fails
  `SOURCE_UNREACHABLE` reason `proxy`, with the PAC entry in the detail. The
  0.12 download transport reached those through Chromium; the message says
  what to ask IT for. git refuses the kinds it cannot map in the same way
  (`run-git.ts:210`).
- **git over http(s).** `run-git.ts:156-171` adds
  `-c http.curloptResolve=<host>:<port>:<address>[,<address>…]`, listing the
  answers that remain after the check. libcurl uses that entry instead of its
  own lookup. `http.followRedirects=false` (`:162`) already keeps every request
  on that host. With a proxy from `proxyFor`, a second entry pins the proxy
  host, checked as for downloads. When curl resolves the target itself
  (a SOCKS proxy without remote resolution), the first entry pins it.
  Otherwise the proxy resolves it under the trusted-proxy rule.
- **git over ssh: preflight check only.** The runner reads the effective
  configuration with `ssh -G [-p <port>] [<user>@]<host>`, run with the same
  environment as the git call. That command prints the configuration after
  evaluating `Host` and `Match` blocks (ssh(1), `-G`). The runner resolves
  the printed `hostname` once and classifies every answer. **If any answer
  violates a hard refusal (§18.3 #3 and #4) or a managed block
  (`blockPrivateNetworks`), the operation is refused** with the refusal of
  the most restrictive such class, and git is not started. The subset
  filtering of *One lookup per connection* does not apply: ssh receives the
  host name, not the checked answers, and may connect to any of them. This
  is the baseline's rule for a git remote today (`checkRemote`,
  `network-gate.ts:116-125`, through `ensurePublicHttpUrl`, which refuses
  when any resolved address is blocked, `core/network-guard.ts:323-338`).
  Answers that need a confirmation the source lacks give
  `SOURCE_CONFIRMATION_REQUIRED` (§18.5), as elsewhere. When `proxycommand` or `proxyjump` is set, the target
  is resolved beyond the proxy, so the runner does not resolve it, the same
  as a PAC proxy that resolves the target itself, and the ssh proxy rule
  above applies. The runner passes no `HostName`, `HostKeyAlias` or
  `CheckHostIP` option: ssh still runs as `ssh -o BatchMode=yes`
  (`run-git.ts:184`), and the user's ssh configuration, known-hosts entries
  and certificate authorities are used unchanged. **Residual:** a DNS
  answer that changes between the preflight and ssh's own lookup is not
  bound, and host-key verification is the trust anchor for SSH.
- **Tests** (slice C), each with a resolver fake that answers a public
  address to the first lookup and `169.254.169.254` or `127.0.0.1` to any
  later one:
  - `pinned-fetch.test.ts`:
    - the request goes to the first answer, and the lookup runs exactly once
      per hop (revert: pass the hostname to the transport);
    - an answer set of public plus metadata connects only to the public
      answer;
    - `PROXY p:8080; DIRECT` never connects directly;
    - one acceptance case per PAC kind against local proxy fixtures:
      `PROXY` with an http and an https target, `HTTPS` (TLS to the proxy,
      then TLS to the target), `SOCKS5` (the request carries the domain name
      type), `SOCKS4` (the request carries the checked IPv4 answer), and an
      unknown kind failing `proxy`.
  - `trusted-proxy.test.ts`, which demonstrates the documented boundary: a
    loopback `PROXY` fixture configured through PAC, and a catalog download
    whose host the fixture resolves to `127.0.0.1`. Ave checks and connects
    only to the proxy address, the fixture reaches its loopback target, and
    the test asserts exactly that. It pins documented behaviour rather than
    a guard, so a change to the boundary changes this test and §18.2.4
    together.
  - `run-git.test.ts`: argv carries `http.curloptResolve` with the
    first-lookup address, and the runner performs no second lookup (revert:
    drop the option).
  - `ssh-preflight.test.ts`, with an `ssh -G` fake that prints the
    effective configuration:
    - the git environment's ssh command is exactly `ssh -o BatchMode=yes`,
      and no `HostName`, `HostKeyAlias` or `CheckHostIP` option appears in
      it or in argv (revert: add a pin option);
    - a printed `hostname` whose resolver answer is `169.254.169.254` fails
      with refusal #3 and git is not started (revert: skip the preflight);
    - **mixed answers**, each from a fixed resolver fake answering both
      addresses on every call: a public address plus `169.254.169.254`
      fails with refusal #3, and a public address plus `10.0.0.5` under
      `blockPrivateNetworks` fails with the policy block; git is never
      started in either case (revert: keep the public answer and run
      git);
    - a config with `proxycommand` set is not resolved by the runner;
    - the documented boundary: the resolver fake answers a public address
      to the preflight and `127.0.0.1` to any later lookup. The preflight
      passes, the runner makes exactly one lookup, and git starts with the
      unchanged ssh command. Like `trusted-proxy.test.ts`, it pins the
      residual stated in §18.2.4, so a change to the boundary changes this
      test and §18.2.4 together.

### 18.3 Hard refusals

> #1–4 and #7 are built (slice C, §7.1, §7.4, §13.1), #5 and #6 in slice D1
> (§7.7). #8 belongs to the Publication plan; a folder's `process` entry is
> already refused (§18.4.9).

Each is refused because no user decision makes it safe. Everything else is a
warning (§18.2) or a policy decision (§18.6).

| # | Refused | Attack it stops |
|---|---|---|
| 1 | `ext::` and every other `<helper>::` transport | `ext::` runs its text as a command; `<helper>::` runs `git-remote-<helper>` from the search path. An address becomes code execution. git itself defaults `ext` to `never`; `GIT_ALLOW_PROTOCOL` stays an allow-list (`run-git.ts:187`) |
| 2 | Credentials in a URL (`https://user:secret@…`, `https://token@…`) | the secret lands in `sources.json`, the Sources view, logs, audit records, backups and git's command line, which other local users can read in the process list. Ave has the encrypted token store (§2.1). An ssh user name (`git@`) is not a credential |
| 3 | `metadata` addresses, for every target, policy-listed hosts included, enforced on the connected address of a direct connection Ave owns (downloads, git over http/https); for SSH a preflight check only; beyond a proxy that resolves the target itself, the trusted proxy enforces it (§18.2.4) | a cloud instance's metadata service hands credentials to any local request. No git server lives there, and a name that resolved elsewhere when the user confirmed it can resolve there at the next connection |
| 4 | Catalog-supplied `this-computer` targets other than the source's own host and port, enforced on the connected address of a direct connection Ave owns (downloads, git over http/https); for SSH a preflight check only; beyond a proxy that resolves the target itself, the trusted proxy enforces it (§18.2.4) | a third-party catalog makes the app send requests to local services (development servers, other apps' control endpoints) that trust any local caller |
| 5 | Reading through a link that leaves a local folder or names a network location (§18.4.5) | a folder that is someone else's checkout links `skills/x/notes.md` to `~/.ssh/id_ed25519`, and the install copies the key into a package the model reads. On Windows a link to `\\server\share` sends the user's network credentials to that server |
| 6 | Any git command against a local folder; git's `file` transport stays `never` (`run-git.ts:158`) | git reads a checkout's own configuration, alternates and hooks; settings such as `core.fsmonitor` run programs |
| 7 | A folder path in a deep link | a web page picks a UNC share (credentials sent on preview) or a planted folder such as Downloads. The Add dialog opens empty and says why |
| 8 | A `process` entry from anything but a sha256-pinned release or archive | owned by `plugin-hostapi-protocol.md` §2.1 and its Publication plan; listed so this table is complete (§18.4.9) |

Not security refusals, but unsupported; each message says what to enter
instead:

- `git://`: the PAC proxy cannot route it, and the same repository is
  served over https or ssh.
- Any other scheme; a query or fragment; whitespace or control characters.
- A relative path: a desktop app has no working directory, and `owner/repo`
  stays the GitHub shorthand.
- A Windows device path (`\\.\…`, `\\?\GLOBALROOT\…`, `\\?\Volume{…}\…`).
- A `file://host/…` URL on macOS or Linux.
- An `unroutable` address.
- An `http(s)` address whose path ends in `marketplace.json` or
  `marketplace.2.json` (decision 11).

### 18.4 Local folders

> Built in slice D1; §7.7 describes it as built, with these differences
> from the text below:
> - A plan captures the package (§18.4.2), so a folder edited after the
>   review cannot reach the install, and `PLAN_EXPIRED` `folder-changed`
>   (§18.8) has no case that raises it. A capture whose digest differs from
>   the fresh snapshot fails the plan with `SOURCE_LOCAL_UNREADABLE`
>   `changed-during-read`.
> - The folder receipt is written without `consent` (§18.4.2); slice F adds
>   it with §18.7.3's baseline.
> - §18.4.8 is built as §15.2, §15.4 and §15.5 describe it. *Show in
>   Finder* re-checks the stored path as a read would before the shell is
>   asked (§7.7), and the review lists the plan's `notInstalled`.

A folder is a marketplace source (its root holds `marketplace.2.json` or the
conventional layout of §3.3) or a direct package (§8).

#### 18.4.1 Input, classification, consent, then resolution

`normalizeSourceInput(input, platform)`, new in
`src/marketplace/net/source-input.ts`, decides folder or git address;
`normalizeSourceUrl` (`source-url.ts:195`) keeps git addresses. A folder goes
through four stages. **Stages 1–3 make no filesystem call on the path**: no
`stat`, `lstat`, `realpath`, `readlink`, `open` or `readdir`. Contacting a
UNC server is exactly what consent and policy must come before.

1. **Lexical parse.** Pure string work:
   - A `file:` URL is converted with `fileURLToPath` for the running platform
     (`file:///C:/m`; `file://server/share/m` → `\\server\share\m` on
     Windows). On macOS and Linux a host other than empty or `localhost` is
     refused.
   - Input starting with `/`, `~`, a drive (`C:\`, `C:/`), `\\` or `//` is a
     folder. `~` expands to `os.homedir()`.
   - `\\?\C:\…` → `C:\…`. `\\?\UNC\server\share\…` and `//server/share/…` →
     `\\server\share\…`.
   - A drive or UNC form on macOS or Linux is refused as a Windows path.
     `C:foo` (drive-relative), `./` and `../` are refused as relative.
   - `.` and `..` segments are removed lexically. A `..` that would climb
     above the drive, share or `/` is refused.
   - Anything else is a git address (§7.1).
2. **Network classification.** Still no file access:
   - Windows UNC (`\\server\share\…`) is `network`.
   - A Windows drive letter is classified with `QueryDosDeviceW("X:")`.
     It reads the drive letter's current mapping from the object manager's
     MS-DOS device namespace for this logon session and opens nothing on the
     drive. The drive is local only when the mapping is
     `\Device\HarddiskVolume<n>`, `\Device\CdRom<n>` or
     `\Device\Floppy<n>`, or a `\??\<path>` (a `subst` drive) whose path is
     itself local by this rule. Anything else — `\Device\Mup\…`,
     `\Device\LanmanRedirector\…`, `\Device\WebDavRedirector\…`, `\??\UNC\…`,
     an unknown device, or a call the OS answers with no mapping — is
     `network`. A wrong guess here produces a warning, never a refusal. A
     helper that is missing, cannot start, times out, or answers outside its
     protocol is not an answer about the drive: the input, or a read of a
     stored folder, fails with `SOURCE_LOCAL_UNREADABLE` reason
     `classifier-unavailable` ("Reinstall Ave"). Guessing `network` there
     would hide a broken install behind a warning.
   - `GetDriveTypeW` is not used: it takes the drive's root path.
   - On macOS and Linux, automount paths are `network` lexically
     (`/net/<host>/…`, and `/Network/…` on macOS), compared ignoring case on
     macOS, whose volumes ignore case by default. `/` is `network` as well:
     reading it reaches the automount roots. Any other path is local: a
     share that is already mounted was authenticated when it was mounted, and
     reading it sends no new credentials.
   - The call goes through a small native helper in the existing Windows
     helper family (`native/windows-job/`, launched as
     `src/main/windows-job-launcher.ts` does), `native/windows-path-kind/`,
     which prints the mapping and does nothing else. Slice D1 adds it, its
     build step and its Windows CI run.
3. **Policy, then consent.**
   - `allowLocalSources`, `block` and the `path:` patterns of §18.6 are
     applied to the lexical path. A block ends here.
   - A `network` folder needs `network-folder` (§18.2.2). Without it, preview
     answers `{ type: "confirm" }` (§18.5) and nothing is touched.
4. **Resolution**, only after stage 3 passes. It walks the path component by
   component with `lstat` and never calls `realpath`. While it establishes
   the root, a link or junction among the entered path's own components —
   an ancestor such as macOS's `/tmp → /private/tmp`, or the root itself —
   is handled by **root resolution**, not by package containment:
   - its text is read with `readlink` and classified as in §18.4.5 rule 1,
     the text and the target it resolves to; a network location is refused
     as `link-to-network`, and the target is never touched;
   - any other text is resolved lexically against the link's directory, and
     the walk continues there, with the same rule for every link it meets
     and the loop limit of §18.4.5 rule 4. No containment applies here: the
     user consented to this path, and the local link is part of where that
     path lives.

   Package containment (§18.4.5 rule 2) applies only **beneath** the
   canonical root once it is established. The walk
   records each component's on-disk spelling from a `readdir` of its parent:
   the entry equal in bytes if one exists, otherwise the single entry equal
   ignoring case. Several such entries fail with `SOURCE_LOCAL_UNREADABLE`
   reason `ambiguous-case`. The result must be a directory; a regular file
   named `marketplace.2.json` or `marketplace.json` resolves to its directory.
   The policy of stage 3 is applied again to this **canonical path**, and a
   block found only now ends the add; so is the network classification, and
   a canonical path on another computer without `network-folder` answers
   `confirm` before anything beneath it is read. The stored `path` is the
   canonical path, and the dialog shows "resolved from <input>" when it
   differs.

   **Every path is classified before it is touched.** Stage 2 judges the
   entered text, but the walk can reach a network location the text did not
   name: the on-disk spelling of `/network/…` is `/Network/…`, and after a
   local link to `/` the next components can be `net/<host>`. So every
   `lstat`, `readdir`, `readlink` and `open` of the walk and of the reading
   after it goes through a fence (`fenceFolderFs`) that classifies its path
   first, as stage 2 would. Without `network-folder` a path on another
   computer answers `confirm` and is not touched; with it the fence is open,
   and links are still judged by rule 1. A fence asks a drive's mapping once
   and keeps the answer, and it judges path spellings, not open handles: a
   mapping changed, or a directory swapped, during one read is the
   concurrent-writer residual of §18.4.5, not something the fence catches.
   A later read of a stored folder requires the canonical path to equal the
   stored one (otherwise `moved`), so the stored path's classification is
   the canonical path's.

Every later read of a stored folder (sync, plan, refresh) repeats stages 2–4
from the stored path, so a drive letter remapped to a share, or a component
replaced by a link, is caught before the read.

#### 18.4.2 Read model: in place, captured by the plan

A folder source is read **in place**. Nothing is copied when it is added or
read. It is read at boot and at each discovery (§18.7.1), on *Refresh*, and
when the Marketplace view opens (at most once a minute per source). There is
no file watcher: network shares and large checkouts make one unreliable.

- The snapshot builder and validation are the git ones (§2.2, §4), over a
  `SourceTree` interface that `BareRepo` and a new `FolderTree` implement.
- **The plan captures the bytes.** Planning an install or update of a folder
  package re-reads the source, then copies the package into the plan's
  staging directory under `workRoot` and computes its digest (§6.4).
  Execution installs that copy and never reads the folder again, so what was
  reviewed is what installs. An abandoned plan's copy is removed at expiry
  (§13.1).
- **A folder source never downloads.** Every kind installs from the files in
  the folder. For a plugin the ladder has one rung, `folder`: `plugin.json`,
  `dist/**` and `assets/**`, compared with the descriptor as in §6.2.
  - Declared `release` or `archive` rungs are not tried.
  - A plugin whose folder has no `plugin.json` fails with
    `NO_INSTALLABLE_ARTIFACT` reason `folder-has-no-build` ("build the plugin
    into `dist/`, or add the git repository instead").
  - Other top-level entries (`src/`, `package.json`, `node_modules/`) are
    ignored and listed in the plan as not installed. The git tree rung keeps
    its stricter rule (§6.2).
- A folder plugin writes receipt schema v4 with `installSource: "folder"` and
  a `folder` record `{ sourceId, sourceOrigin, revision, packagePath,
  treeSha256, authoritySha256, consent }` (`plugin-install-receipt.ts:86-100`
  gains the union member; `consent` is §18.7.3's baseline). The registry
  `origin.rung` is `"folder"` (`src/plugins/registry.ts:304-315`). It never
  qualifies for a host-secret grant (§10.3 condition 2) or a `process` entry
  (§18.4.9).

#### 18.4.3 Revision, history and versions

§7.3's pin is a commit; a folder's pin is a **revision**: `local-` + the hex
sha256 of the lines `"<sha256(file)> <path>\n"`, sorted by path bytes, over
every file the snapshot read (the index or the descriptors of §3.3,
`policy/revocations.json`, the app-conditional revocations file), plus one line
`"<tree digest> <package path>/"` per package, whose tree digest (§6.4) covers
the files that package would install. Editing any installed file changes the
revision.

- The revision stands wherever a pin is stored: `pinnedCommit` in
  `state.json`, `snapshots/<revision>.json`, `origin.commit` in the registry
  and ledger, plan `snapshotCommit`, and retention (§2.1). The 40-hex checks
  (`registry.ts:87`, `sync.ts:49`, the registry origin check at
  `src/plugins/registry.ts:304-315`) accept `^local-[0-9a-f]{64}$` for a folder
  source only, and a folder source refuses a 40-hex value.
- No history rule: every read is the folder's current state. `pendingRewrite`
  and `SOURCE_HISTORY_REWRITTEN` never apply.
- Only the version whose files are in the folder can be installed. Other
  `versions[]` entries of the index show as history and are not offered; their
  `commit` values are not checked. The version in the folder must equal its
  index copy (§6.2).
- A git checkout is read as its **working tree**. `.git` is never read or
  installed, and no git command runs (§18.3 #6). Uncommitted edits are
  included, which is what an author iterating expects.

#### 18.4.4 Identity and duplicates

- Two folder sources are the same when their canonical paths (§18.4.1
  stage 4) are equal byte for byte, or when both directories report the same
  non-zero `dev` and `ino` from `fs.stat` with `bigint: true` (volume serial and
  file index on Windows). No platform-wide case folding: on a case-sensitive
  volume `/Approved/Tools` and `/approved/tools` are two folders and stay two
  sources; on a case-insensitive one the walk's on-disk spelling and the
  equal `dev`/`ino` make them one. This also catches a mapped drive and its
  UNC path.
- When `stat` reports `dev` or `ino` as zero (some network filesystems), only
  the canonical path decides. Two spellings of one folder are then treated as
  two sources, which can list a package twice but admits nothing new.
- A folder that is already a source, or that contains or lies inside one, is
  refused with `SOURCE_ID_TAKEN` naming that source: folder sources may not
  overlap, since nesting can list a package twice (whether it does depends
  on what the outer index lists, so the sentence says only that they
  overlap). Paths decide first; then identities, which see through an
  alias (a second drive letter or share for one directory, a firmlink, a
  bind mount). Stage 4 records the `dev`/`ino` of the folder and of every
  directory above it on the canonical path, and each read stores them in
  the source's `state.json` (`folder.ancestors`). A new folder lies inside a
  source when one of its ancestors is that source's directory, and contains
  one when it is among that source's recorded ancestors. Zero identities
  take no part, as above.
- A folder source and a git source are never the same source, even when the
  folder is a checkout of that repository. The same `(kind, name)` shows as two
  cards (§15.1); installing the second is a source switch.
- `SourceEntry` (`registry.ts:39-49`) gains `path?: string`, exclusive with
  `url` (slice D1), and `acknowledged?: SourceWarning[]` (§18.5, slice C).
  `ENTRY_KEYS` (`registry.ts:88`) gains each with its slice.
- A folder entry has `auth: { kind: "none" }` and no `ref`. A stored `path`
  whose walk no longer ends at the same directory (a component replaced by a
  link, or `dev`/`ino` changed) is served as `SOURCE_LOCAL_UNREADABLE` reason
  `moved`, and the new target is never read.

#### 18.4.5 Reading the files

`FolderTree` and the resolution walk share one link rule. Every filesystem
call goes through a `FolderFs` interface (`lstat`, `readlink`, `readdir`,
`open`, `fstat`, `read`, `queryDosDevice`), which the tests replace with a
recording fake.

- Directories are walked, regular files read. A device, socket or FIFO fails
  the package: `CONTENT_RULE_VIOLATION` reason `special-file`.
- **A symbolic link or junction** is never followed by the OS. Only its text
  is read, with `readlink`, and the text is judged before any call touches
  the target:
  1. Text naming a network location is refused from the text alone:
     `\\…`, `//…`, `\??\UNC\…`, `\\?\UNC\…`, a device path, a drive letter
     that stage 2 classifies `network`, or an automount path. So is text
     that resolves (rule 2's lexical resolution) onto a network location
     other than the link's own: relative text can name one too
     (`Network/Servers/…` from `/`, `../../other` under `/net/<host>`).
     `CONTENT_RULE_VIOLATION` reason `link-to-network` names the link. This
     holds inside a network-folder source too: the user consented to that
     share, not to the servers its links name.
  2. Otherwise the text is resolved **lexically** against the link's own
     directory. Outside the source root → reason `link-outside-folder`, and
     the target is never touched.
  3. Inside the root → the walk continues at the target, component by
     component, with the same rule for every link it meets. A chain
     `root/a → root/b → \\attacker\share` is therefore stopped at `b`'s text,
     and nothing calls the server.
  4. A directory reached twice, or more than 40 links in one resolution, is
     a loop and fails the package.

  The installed copy holds the target's bytes as a regular file. For the
  index or a revocations file, a refused link fails the whole read.
- **Opening a file** uses `O_NOFOLLOW` on macOS and Linux, which protects
  only the final component. After the open, `fstat` must report the
  `dev`/`ino` that the walk's `lstat` saw.
- **Detecting persistent swaps.** The walk records each directory's
  `dev`/`ino` when it enumerates it. After each file is read, it re-`lstat`s
  the directory chain from the canonical root to that file's directory and
  compares every entry; it compares the `fstat` of the file as well. Any
  mismatch fails the read with `SOURCE_LOCAL_UNREADABLE` reason
  `changed-during-read`, and the bytes are discarded. A swap that is still in
  place when the file has been read is therefore caught.
- **Concurrent replacement boundary, every platform.** Node has no portable
  traversal anchored to held directory handles (`openat`), and this design
  does not promise one. A process with write access to the source tree that
  replaces an intermediate directory with a link and restores it between
  the walk's checks can redirect a read. The bytes captured are bytes of a
  file the user could already read, and they can reach the package. On
  Windows, where Node's open follows reparse points, the same window can make
  Ave contact a UNC server. This residual needs a concurrent local writer
  in a folder the user chose as a source, and it is stated, not defended.
  *Show in Finder* has the same kind of boundary between its last
  classification and the shell call (§7.7, reveal boundary).
- Skipped silently at any depth, never read, digested or installed: `.git/`,
  `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, compared ignoring case. The
  rule holds for every path the reader follows, not only for names it
  enumerates: each component takes the spelling its parent lists (the
  entry with the same `dev`/`ino` when the typed spelling differs — a case
  variant, a Windows 8.3 or trailing-dot alias), so `.GIT` or `GIT~1` is
  `.git`. A link whose target passes through a skipped entry fails the
  package with `CONTENT_RULE_VIOLATION` reason `link-to-skipped`, nothing
  beneath it listed or opened; a path naming one (an index entry) finds
  nothing.
- **Hard links** are regular files, read like any other. Path containment is
  what the reader enforces, not inode isolation: a hard link names a file,
  never a directory, and never one on another volume or computer, so it
  reaches no byte the user could not already read and no server. Refusing
  link counts above one would refuse ordinary trees (package-manager stores,
  `cp -al` copies) and protect nothing the containment rules do not.
- Names are normalized to NFC (the form git stores). Two names equal after NFC,
  or differing only in case, fail the package (§5.5).
- The execute bit comes from `lstat` on macOS and Linux; Windows has none, so
  every file is `100644` there.
- §5.4's limits apply while reading; a read stops at the first one exceeded.
- The repository check still refuses links when the package is published to
  git; the preview's diagnostics say so.

#### 18.4.6 Windows

- Drive and UNC paths are accepted; a junction is a link (§18.4.5).
- Reading a network folder signs in to its server as the user: the
  entered-target warning `network-folder` (§18.2.2) says "Ave signs in to
  <server> with your Windows account to read this folder". The server name
  comes from the UNC path or from the drive's `QueryDosDeviceW` mapping.
- A locked file, a cloud-storage placeholder that cannot download, or a
  permission error fails the read with `SOURCE_LOCAL_UNREADABLE` reason `io`
  and the OS message. The last good snapshot is served (§7.5) and the next
  read retries.
- The stored path never carries `\\?\`; Node adds the long-path prefix itself.
- Bytes are read as they are: a CRLF checkout installs CRLF files.

#### 18.4.7 Direct install from a folder

*Install from Git URL or folder…* (§15.1) takes a folder path or *Choose
folder…*. Detection is §8.1's, at the folder root. The result is a `direct`
source with a `path`; it updates when the package's digest changes (§18.7.6).
A synthesized version (§8.2) is `0.0.0+t<digest12>`. Reading the bundle's
files keeps a failure's own reason (a link rule of §18.4.5, an unreadable
folder, `classifier-unavailable`); only a tree that breaks the package's
content rules is `SOURCE_INDEX_INVALID`.

- The plugin studio's *Install from file* (`plugin-studio.ts:168-175`) stays a
  one-time, source-less install of a zip or folder (decision 30).
- The development-only local plugin install (`plugins.ts:449-453`, behind
  `isDevModeUnlocked`) is unchanged.
- Policy `allowDirectInstall: false` (§12) or `allowLocalSources: false`
  (§18.6) refuses it.

#### 18.4.8 How a folder source looks

- **Sources** (§15.4):
  - folder glyph and the label "Folder";
  - the path, middle-truncated, with the full path in a tooltip;
  - `folder · <revision 7>` and "read <time>";
  - statuses *Up to date*, *Folder not found*, *Folder unreadable*,
    *Folder moved*;
  - overflow *Refresh*, *Show in Finder* / *Show in Explorer* /
    *Show in file manager*, *Remove*. No *Set token*.
- **Package sheet** (§15.2): Provenance "Folder <path>, read <time>, contents
  <digest12>"; Versions "Only the version in the folder can be installed".
- **Add dialog** (§15.5): the address field accepts a path and has *Choose
  folder…*; the preview says "Changes in this folder are picked up at start-up,
  every few hours and on Refresh".

#### 18.4.9 `process` entries, http sources and folders

`plugin-hostapi-protocol.md` §2.1, on `main`, admits a `process` entry only
for an install whose artifact came through a sha256-pinned `release` or
`archive` rung, recorded in the receipt. Its implementation is the
Publication plan, §9.7 of that page (`plugin-hostapi-protocol.md:2222`, on
`main` since #2592). Of its slices (`:2645-2650`), M1 has merged (#2591), S1
and P1 are being built, and P3 (the `process` runtime and its codes,
`:3557`) and P4 (marketplace admission, `:3871`) are unbuilt. P4 already
states that a local directory source is refused like `installLocal`
(`:3887-3889`). This design does not relax the rule.

- **Codes over time.**
  - Today `main` refuses every `process` entry with
    `process-entry-unsupported` (`src/marketplace/errors.ts:37`,
    `src/plugins/process-entry-support.ts:3`).
  - P3 replaces that code with `process-entry-unconfined` and
    `process-entry-requires-pinned-artifact`.
  - §18.8 carries a sentence for all three, and slice B ships whichever exist
    on `main` when it merges.
- **Folder sources and direct folder installs** never use a release or archive
  rung (§18.4.2). Their receipts (`installSource: "folder"`) are categorically
  ineligible for `process` admission, under any later rule. Slice D1 refuses a
  `process` manifest from a folder at the ladder:
  - with `process-entry-unsupported` while that is the code on `main`;
  - with `process-entry-requires-pinned-artifact` once P3 has merged — the
    code it was built with, at the folder rung and again by the installer.

  Whichever of D1 and P4 merges second keeps that refusal on the folder path,
  so it never lapses between them.
- **http sources**: the rule holds as written. A network attacker can replace a
  pin together with its artifact, which is why an http source's packages never
  update automatically until the user accepts `unencrypted-updates` (§18.7.2).

### 18.5 Add flow, confirmations and badges

> Built in slice C for git addresses (§7.2, §15.4, §15.5), in slice D1
> for the folder steps and `network-folder` (§7.7), and in slice D2 for
> *Choose folder…* and the *Network folder* and *Local folder* badges (§7.7,
> §15.4, §15.5). `unencrypted-updates` belongs to slice F.

1. The user enters an address or chooses a folder.
2. `sources:preview` parses it (§7.1, §18.4.1 stages 1–2) and applies the
   refusals (§18.3) and the policy (§18.6). A refusal or a policy block ends
   here.
3. It classifies the target (§18.2.1, §18.4.1 stage 2). If a warning is
   needed that the request does not carry in `acknowledge`, preview answers
   `{ type: "confirm", warnings }` and runs **no git command, no DNS-dependent
   connection and no filesystem call on the folder**. *Continue* repeats the
   preview with `acknowledge`.
4. Preview fetches or resolves and reads (§7.2, §18.4.1 stage 4, §18.4) and
   classifies; warnings show as badges.
5. *Add* stores exactly the confirmations the preview carried.

- **Stored**: `SourceEntry.acknowledged` for custom and direct sources;
  `SourceState.acknowledged` (`STATE_KEYS`, `registry.ts:89`) for official and
  managed ones. Values: `unencrypted`, `token-unencrypted`, `internal-network`,
  `this-computer`, `internal-downloads`, `network-folder`,
  `unencrypted-updates`.
- **A target that changes class** (a name now resolves to an internal address,
  a drive letter now maps to a share) fails the sync, install or update with
  `SOURCE_CONFIRMATION_REQUIRED`. The row shows *Allow…*, which calls
  `sources:acknowledge` and syncs again. Confirmations are per class, not per
  address.
- **Badges** on the source row and its package cards, text plus tooltip, never
  colour alone (§15.9): *Unencrypted (http)*, *Internal network*, *This
  computer*, *Internal downloads*, *Network folder*, *Local folder*. The http
  tooltip: "Anyone on the network path can read what this source sends and
  change what it serves. Updates from it are not installed automatically."
- Withdrawing a confirmation or changing the address means removing the
  source and adding it again.

### 18.6 Managed policy additions

```jsonc
"marketplaces": {
  "requireHttps": false,          // true: plain http is a policy block (allowHttpHosts excepted)
  "blockPrivateNetworks": false,  // true: internal and this-computer targets are a policy block (policy-listed hosts excepted)
  "allowLocalSources": true,      // false: folder sources and folder installs are a policy block
  "autoUpdate": "user",           // "user" | "on" | "off" (§18.7.2)
  "allow": ["https://github.com/acme/*", "host:git.corp.example", "path:/opt/acme/marketplaces/*"],
  "block": ["path:/tmp/*"],
  "additional": [{ "id": "acme-local", "path": "/opt/acme/marketplaces/tools" }]
}
```

- `requireHttps` and `blockPrivateNetworks` apply to entered and
  catalog-supplied targets, downloads and redirect hops included.
  `blockPrivateNetworks` is enforced on the connected address of a direct
  connection on the transports Ave owns (downloads, git over http/https);
  for SSH it is a preflight check only; beyond a proxy that resolves the
  target itself, the trusted proxy enforces it (§18.2.4). They restore
  0.12's refusals as blocks no confirmation passes.
- **`path:` patterns.** `path:<folder>` matches that folder,
  `path:<prefix>*` every folder under the prefix, and `path:*` every folder;
  `/` and `\` are equal.
  - They are compared with the lexical path at stage 3 and again with the
    canonical path at stage 4 (§18.4.1). The case rule is conservative, since
    the volume's case sensitivity is not known when the rule is written: an
    `allow` pattern matches only with exact case, and a `block` pattern
    matches ignoring case. A block therefore covers every spelling, and an
    allow admits only the spelling the administrator wrote, which the walk
    recovers from the disk on a case-insensitive volume.
  - `path:` patterns apply to folders only; `host:` and URL patterns apply to
    git sources only.
  - When `allow` is present a folder must match one of its `path:` entries,
    so an existing allow list blocks folders until the administrator adds one
    (fail closed, as §12).
- `additional[]` takes `path` instead of `url` for a provisioned folder:
  origin `managed`, no warnings except `network-folder`, which the policy entry
  implies, and not removable. An `additional` folder under
  `allowLocalSources: false` makes the section invalid (§12).
- User settings, confirmations and switches never override a policy block.
- `requireHttps`, `blockPrivateNetworks` and the policy refresh below are
  built (slice C, §12); the rest of this section is not.
- **When a policy change takes effect.** Before slice C the policy was read
  once when the service was built, and the service was cached, so a change
  waited for a restart. Since slice C:
  - The service reads the policy through a `PolicySource`. At the start of
    every operation (preview, add, acknowledge, sync, discovery, plan,
    execute), it compares the file with the last read (as built: identity,
    times trusted outside a racy window, and sha256, §12).
  - A change builds a new policy and swaps it into the gate, the registry
    filters and the installers in one step, under the service's operation
    lock, so no operation sees a mixed policy.
  - A plan records the policy digest it was made under. Executing it under
    another digest fails with `PLAN_EXPIRED` reason `policy-changed`, and the
    review reopens with a fresh plan.
  - A policy that becomes unreadable or invalid behaves as today's invalid
    policy (`git-marketplace.ts:252-254`): official only, with
    `policy-invalid` shown. It recovers at the first operation after the file
    is fixed.
  - Discovery (§18.7.1) is an operation, so a source the new policy blocks is
    blocked within one discovery interval, without a restart.
- **Rollout.** Apps up to and including 0.13.0 read the section exactly and
  treat an unknown key as an invalid section, which blocks every non-official
  source (§12). Deploy each key only to the release that carries its slice
  and later.

### 18.7 Automatic updates

#### 18.7.1 One scheduler, two due rules

The background tick (`background.ts:156-170`) stays the only scheduler. It
runs a **due check** at boot (right after the boot pass, `background.ts:154`),
every hour, on `powerMonitor` `resume`, on *Check now*, and on a settings
change. The due check starts what is due:

```
discovery (due: rule below)
  sync every source that syncs (§7.3; a folder source is read, §18.4.2)
  enforce revocations (§10.4)                    -- always, whatever the settings
  compute updates (updateFor, identity.ts:79); publish notices and status
apply check (due: rule below)
  run a discovery first, or join the one in flight
  classify each update that discovery returned (§18.7.2, §18.7.3)
     automatic -> enqueue for the apply queue (§18.7.4)
apply queue (separate, one package at a time, waits for idle)
```

- **Discovery is due** by one of two branches:
  - **after a failed attempt** (the last result is `offline` or `partial`, or
    the attempt threw): when `lastAttemptAt` is at least 1 hour old, whatever
    `lastSuccessAt` says. A failed or offline attempt, including one started
    by *Check now*, is therefore retried at the next hourly due check;
  - **after a successful attempt**: when `lastSuccessAt` is at least
    `updateCheckIntervalMs` old.

  `updateCheckIntervalMs` keeps its key, its 6-hour default
  (`background.ts:23`), its `0` (boot and *Check now* only), its 15-minute
  floor, and its lack of an upper bound (`background.ts:25-32`). With `0`,
  the failed-attempt branch still retries hourly until a discovery
  succeeds.
- **The apply check is due** at boot, on *Check now*, and when the last
  successful apply check (`applyCheckAt`) is 24 hours old or older. That is
  the owner's "at boot and once a day" for updates. **A due apply check
  always obtains a fresh discovery first**: it joins a discovery already in
  flight, or starts one, and classifies only that discovery's results. There
  is no freshness predicate, so the age of the last discovery and the phase
  of the discovery interval never decide what is classified. That discovery
  is an ordinary one: it records `lastAttemptAt` and `lastSuccessAt` and so
  restarts the discovery interval. Its result decides the rest:
  - `ok`: every update is classified, and `applyCheckAt` is written;
  - `partial`: updates from the sources it reached are classified, the
    others wait, and `applyCheckAt` is not written, so the apply check stays
    due and joins the hourly retry of the failed-attempt branch;
  - `offline` or `error`: nothing is classified, and the apply check stays
    due the same way.
- **Why discovery stays at 6 hours.** Revocations arrive in the same fetch as
  the index (§10.4). 0.12 delivers them to a running app within 6 hours, and
  stretching discovery to the 24-hour update cadence would leave a revoked
  package running four times as long. Discovery costs one fetch per source,
  and it applies nothing.
- **Discovery never waits for apply.** The apply queue is a separate worker.
  A discovery finishes, records its time and publishes status even while the
  queue waits for idle (§18.7.4). `updates:check` resolves when its discovery
  and apply check end; queued updates then show `waiting`. A later apply check
  replaces queued entries with its own results and leaves a package that is
  already applying alone.
- **Timing guarantee.** While the app runs, is awake and reaches a source, a
  revocation or update published there is discovered within
  `updateCheckIntervalMs` + 1 hour (7 hours by default). Sleep is caught up
  on `resume`. An eligible update is classified within 25 hours of
  publication: the next apply check is due at most 24 hours after the last
  one, runs at the next hourly due check, and always discovers first. It is
  applied when the conversation is next idle. **The wait for idle has no
  bound**: after 30 minutes the user is told and can apply at once
  (§18.7.4), which is an escalation, not a
  limit. Exceptions:
  - `updateCheckIntervalMs: 0` — scheduled discovery only at boot and on
    *Check now*, plus hourly retries after a failure; the daily apply check
    still runs and obtains its own discovery;
  - offline — retried hourly;
  - a source failing — its packages wait, and the others proceed.
- **Remembered**: `~/.ave/marketplaces/updates.json`:

  ```
  { version: 1,
    discovery: { lastAttemptAt, lastSuccessAt, result: "ok" | "partial" | "offline" | "error" } | null,
    applyCheckAt: string | null,
    packages: { "<sourceId>:<kind>:<name>": { to, state, attempts, lastError?: { code, detail?, at }, appliedAt? } } }
  ```

  An unreadable file is replaced by an empty one and the Updates card says so.
  That only moves timing and retry counts, never what applies.

#### 18.7.2 Defaults and switches

An update applies automatically only when every **precondition** holds:

- the package is enabled (not disabled by the user or by a revocation);
- its source is shown (a hidden source still syncs, but installs from it are
  `SOURCE_DISABLED`, `service.ts:725-727`);
- it is an upgrade: never a downgrade, never a source switch;
- the source has no pending history rewrite (§7.3);
- the version is not skipped (`skippedPluginUpdates`,
  `skipped-plugin-updates.ts:95-103`);
- it has not failed three apply attempts in a row (§18.7.5);
- **every MCP server and hook approved in the running generation keeps its
  approval**: each one either carries forward (§18.7.3) or is absent from
  the new version. Otherwise the update is `needs-review`. This is an
  invariant: an automatic update never leaves a previously approved
  component unapproved;
- for a source reached over plain http, the source holds
  `unencrypted-updates` (a network attacker can serve a new commit with new
  pins; applying it unattended would run their code with no action from the
  user).

Then the first of these that is set decides:

1. policy `autoUpdate`: `"off"` or `"on"`;
2. the package switch `marketplace.autoUpdatePackages[<key>]` (`"on"`/`"off"`;
   key = `packageUpdateSkipKey`, `skipped-plugin-updates.ts:87`);
3. the source switch `marketplace.autoUpdateSources[<sourceId>]`;
4. the global switch `marketplace.autoUpdate` (`false` = off);
5. the default for the origin:

| Source | Default |
|---|---|
| official | on |
| managed (`additional`) | on; policy `autoUpdate` may lock it |
| custom, https or ssh | on |
| custom or direct over http | **off** until the user turns it on and accepts `unencrypted-updates` |
| direct (git) | on |
| folder (custom or direct) | on: an author's edit reaches the app without a manual step |

The default is broad because §18.7.3 holds back every update that changes
what runs or what it may reach. An update that applies by itself changes
only a package with no local executable component, or changes nothing its
executable components can reach.

**`requiredInstalls` (§10.2)** updates at every apply check, with
`required: true` (`service.ts:1031-1033`), through the same apply queue as
automatic updates, so it waits for idle like them, at boot too. The policy
stands for the user's consent there, and only there. Exactly:

| Rule | Required installs |
|---|---|
| global, source and package switches; skipped versions | overridden: they do not apply |
| source switch to the policy's source | allowed, as today (`run.ts:136`) |
| authority fields of the consent fingerprint (§18.7.3) | approved by the policy: `reviewedAuthority = true`, as today |
| MCP servers and hooks | **not** approved by the policy. Carry-forward (§18.7.3) keeps an unchanged one approved. A new or changed one installs unapproved: the manager does not publish an unapproved projection (`mcp-manager.ts:393`), so it does not run, and the package enters `approval-pending` (§18.7.5) with a notice and *Review* right after the install. The approval-carrying invariant above is the one precondition required installs override, and `approval-pending` is how the override stays visible |
| revocation | mandatory: a revoked version is never installed |
| compatibility (`row.choice.state === "candidate"`, `run.ts:150-153`) and no downgrade (`updateFor`) | mandatory |
| idle gate (§18.7.4) | mandatory, at boot too |
| three-failure stop | does not apply: a failing required install is retried at every apply check and stays visible as `failed` |

The first install of a package that is not yet present (a new default or
required install, §10.2) keeps today's boot path (`service.ts:1004-1039`):
it replaces no running generation, so it cannot interrupt a turn.

#### 18.7.3 Consent: what never applies automatically

An update applies automatically only when its **consent fingerprint** equals
the installed **baseline**. Any difference, a narrowing included, makes the
update `needs-review`.

**Fingerprint.** `consentFingerprint(kind, subject)`, new in
`src/marketplace/updates/consent.ts`, returns a typed record that is
serialized as canonical JSON with sorted keys:

| Kind | Fields |
|---|---|
| `plugin` (extension) | `minAppVersion`; `hostProtocol`; every `PluginAuthority` field (`capabilities`, `networkAccess`, `hostSecrets`, `pluginAccess`, `auth`, `requires.capabilities`, `dependencies`, `sandbox`); the entry form (`entry` or `process`); the set of bundled contribution kinds; every bundled MCP server and hook by local id with its **approval digest**; for a `process` entry, the package digest below |
| `agent-plugin` | `minAppVersion`; `hostProtocol`; the set of component kinds present; every MCP server by name and every hook by local id with its approval digest; `mcpAuth` (`extensions-and-plugins.md` §5.2, decision 18) |
| `mcp` | the resolved runtime spec (§5.2): transport, command, arguments, environment names and fixed values, URL, sign-in fields, docker options, package or image with version |
| `provider` | `minAppVersion`, `providerId`, `baseUrl` |
| `messaging-connection` | `minAppVersion`, the whole `connection.json` |
| `skill`, `agent`, `theme`, `font`, `language` | `minAppVersion` |

- This is the owner's list: new or changed permissions and grants (authority
  fields), a changed MCP server or hook, `sandbox`, a protocol or
  `minAppVersion` change, a new component kind.
- An `mcp` package's version is part of its command, so every `mcp` update
  needs review.
- **Local executable component**: a stdio MCP server, a command hook, or a
  `process` entry. A package that has none — skills, prompts, agent
  profiles, routine templates, remote MCP servers, an extension whose code
  runs only as its in-process entry under its declared authority — applies
  changed text and data automatically: `extensions-and-plugins.md`
  decision 18 activates them without a separate consent, and a routine
  template creates nothing.
- A package that has **any** local executable component needs review for
  **any** change to its files (below). The review is made cheap, not
  skipped (§18.7.3 "The delta").

**Approval digest.** It covers what executes and everything it can read. The
static fingerprint (`plugin-contributions.ts:249-271`) hashes only the
declared descriptor file, and the anchored fingerprint covers only paths in
argv (`plugin-bundled-command.ts:37-71`). No runtime boundary stops an
unchanged server from reading another file of its package and evaluating
it: an approved `server.js` can evaluate `skills/helper/assets/rules.txt`,
and the content rules admit such resources (`content/rules.ts:45-69`). So no
file of the package is excluded by extension, location or execute bit. For
each bundled MCP server and hook,
`approvalDigest(component, generationRoot)`, new in
`src/plugins/contribution-approval-digest.ts`, is the sha256 of canonical
JSON:

```
{ declaration: <static fingerprint, plugin-contributions.ts:269-271>,
  anchored:    <the identities anchorBundledCommand hashes:
                "<argv index>\0<relative path>\0<sha256(file)>", sorted
                (plugin-bundled-command.ts:53-71)>,
  closure:     { kind: "package",  treeSha256 }       // local code
             | { kind: "launcher", spec, treeSha256 } // pinned runtime package
             | { kind: "remote" } }                   // url transport; nothing local runs
```

- **`treeSha256`** is the tree digest (§6.4, the algorithm behind the
  receipt's `artifactSha256`) over **every** installed payload file of the
  package, with exactly **one normalization**: the top-level `version` field
  of `plugin.json` is removed before that file is hashed (the file is parsed,
  the field deleted, and the rest serialized as canonical JSON with sorted
  keys). There is no other normalized field. A release must change that
  field (`plugins/marketplace.ts:635-642`), and it changes nothing that
  runs. Content packages need no normalization, because their descriptor
  `ave-package.json` is not installed (`content/store.ts:114-128`).
- **`launcher` closure.** For `npx`, `bunx`, `uvx`, `pipx run` and
  `docker run` the spec names an immutable artifact: npm or PyPI at an exact
  version (`name@1.2.3`, `name==1.2.3`), or an OCI image by `@sha256:` digest.
  `treeSha256` is included as above, because the package's files may still
  be read.
- **`remote`**: a url transport component in a package with no local
  executable component. A remote component in a package that also has a
  local one stays `remote`: it runs nothing locally, and the local
  components' digests already cover the tree.
- **Undeterminable.** When the executable closure cannot be determined, the
  approval digest is `null`. That covers a launcher spec without an immutable
  pin (`npx foo`, `foo@latest`, an image tag), an `anchorBundledCommand`
  failure, and a command type this list does not name. A `null` digest never
  equals anything: that component has no carry-forward, re-asks on every
  update, and its fingerprint always differs, so the update needs review.
  This case fails closed.
- A `process` entry is in the extension's fingerprint as the same
  `treeSha256`, so a `process` extension needs review for any change.

**Baseline storage.** The baseline is the fingerprint the user accepted,
stored with the install. It is never derived from newly fetched catalog
metadata. `planUpdate` stops preferring the current catalog's copy of the
installed version (`service.ts:795-797`) and reads the baseline.

| Kind | Stored in |
|---|---|
| `plugin` | the receipt's `git` or `folder` record gains `consent` (`plugin-install-receipt.ts:86-100`); optional, so existing receipts stay valid |
| content kinds | `LedgerEntry.origin.consent` (`content/ledger.ts:22-48`; `ORIGIN_KEYS` gains `consent`, optional) |
| `mcp` | the record in `~/.ave/packages/mcp-installs.json` (`app/mcp-installer.ts:38-62`) gains `consent` |

**Existing installs** (no stored baseline) get one computed from what is
installed, never from the catalog:

- `plugin`: the receipt-covered `plugin.json` and payload.
- Content: the installed package directory. `minAppVersion` comes from the
  index row of the installed version in the retained
  `snapshots/<origin.commit>.json`, which is the catalog the user installed
  from, kept by snapshot retention (§2.1). Install itself discards
  `ave-package.json` (`content/store.ts:114-128`).
- `mcp`: the recorded runtime spec.

A field that cannot be computed — a missing snapshot, or a folder install
whose folder has changed since — is `unknown`. An `unknown` field never
equals anything, so the first update needs review, and applying it stores a
complete baseline. Each successful install or update, automatic, reviewed or
required, writes the new baseline in the same transaction as the receipt or
ledger entry.

**Two checkpoints and the delta.**

- **Checkpoint one, the catalog.** A field is *catalog-observable* when the
  index copy of the version carries it (§2.2). A catalog-observable
  difference stages the update as `needs-review` with no download. A field
  the catalog does not carry is `pending`, never "equal".
- **Checkpoint two, the staged bytes.** It runs only when checkpoint one
  found no difference, before activation. `installGitPlugin` takes an
  `assertConsent` callback, run beside `assertManifest`
  (`plugins/marketplace.ts:635-643`). The callback computes the full
  fingerprint, approval digests included, from the staged tree and throws
  `UpdateNeedsReviewError` before `activatePreparedArtifact`. Content runs the
  same check on the staged package before the ledger is written. Nothing
  activates, and the staged files are dropped. The pass catches
  `UpdateNeedsReviewError` itself (`installZipTransaction` rethrows it,
  `plugins/marketplace.ts:831-836`, `:862-878`) and records `needs-review`. A
  consent deferral is never a failure and never counts as an attempt.
- **Manual review always stages.** Every manual review whose delta has any
  `pending` field downloads, verifies and stages the artifact into the plan,
  as a folder plan does (§18.4.2), and computes the complete fingerprint
  **before** approval is offered, whatever checkpoint one found. An update
  that adds a catalog-visible capability and a bundled hook therefore shows
  both. The plan records the staged digest, and `executeInstall` installs
  exactly those staged bytes and never downloads again, so approval covers
  the bytes that install. An expired plan (§13.1) means a fresh review.
- **The delta.** A typed
  `ConsentDelta = Array<{ field: ConsentField; checkpoint: "catalog" | "staged"; before: Json | "unknown"; after: Json; changedFiles?: { code: string[]; nonCode: string[] } }>`,
  where `ConsentField` names every row of the table above, for example
  `authority.networkAccess`, `entryForm`, `mcpServer:<localId>`,
  `hook:<localId>`, `mcpRuntime` and `connection`. After staging no `after`
  is pending. `UpdatePlanView` gains `consentDelta`. The existing
  `authorityDelta` and `componentsDelta` (`service.ts:799-810`) become
  projections of it.
- **Cheap review for code-free changes.** `changedFiles` lists, for a changed
  approval digest, the package paths whose bytes differ, compared with the
  **same single normalization** as `treeSha256`: `plugin.json` is compared
  with its top-level `version` removed, and is listed only when the rest
  differs, then always as `code`. A complete versioned release that edits
  only `SKILL.md` therefore lists `SKILL.md` alone. The renderer splits
  them for display only: `nonCode` holds Markdown, plain text, images and
  JSON outside `plugin.json`; `code` holds everything else. When the only
  differing fields are approval digests (and `minAppVersion` is unchanged)
  and every `changedFiles.code` is empty, the review shows one row, "Only
  these non-code files changed:" with the list, and one action, *Approve
  update*. That action approves every changed component of the package in
  one step. The split never decides eligibility; it only shortens the
  review.
- **Otherwise** the review renders one row per entry: the field's localized
  label, before and after, and for `mcpServer:` and `hook:` rows an approve
  check box with the command, its closure kind and its changed files.
- **Extension components.** `executeInstall` today rejects component consents
  for anything but an agent plugin (`service.ts:826-827`). From slice F it
  accepts them for `plugin` too, by bundled local id, and the plugin
  installer passes them to `PluginBundleLifecycle`, which approves them for
  the new generation's `mcpTrust` and `hookTrust`.

**Approval carry-forward.** Today the trust stores key on the exact
generation and "approval never transfers across generations"
(`plugin-contribution-trust.ts:7-13`, `:31`), so every update re-asks for every
bundled server and hook.

- **Schema.** The trust file goes from `{ version: 2 }` to `{ version: 3 }`.
  Each record gains `approvalDigest: string | null` and an optional
  `carriedFrom: <generationId>`. The loader accepts version 2 strictly as
  today (`:40-53`) and version 3 strictly too; any other version fails as
  today. The next write is version 3.
- **Migrating a version-2 record**, once, when the release after 0.13.0 first loads the store
  (stated decision 39). If the record's generation is the active generation
  of its plugin, and its fingerprint equals the fingerprint computed from
  that installed generation's declaration, its `approvalDigest` is computed
  from the installed bytes. Those are the bytes the user approved and is
  running, and the v2 identity already bound them (the generation id commits
  to every receipt-covered byte). Any other v2 record gets
  `approvalDigest: null`. A null record cannot carry, so by the precondition
  of §18.7.2 the package's first update is an explicit, one-time
  `needs-review`, with the reason "approval from an earlier Ave version must
  be confirmed".
- **Prepare.** When a new generation G′ of plugin P is prepared, a component
  c′ is carried when the active generation G holds an approved record with
  the same plugin id and local id and a non-null `approvalDigest` equal to
  c′'s. A carried component gets a **provisional** approval for G′ with
  `carriedFrom: G`, written before preparation, because MCP admission happens
  during preparation (`agent-plugin-mcp-runtime.ts:117-125`). It joins the
  same list as new approvals.
- **Publish.** Under the lifecycle's serialization, before the active
  generation changes, each provisional record is revalidated: G must still be
  active, and the source record must still be approved, so a revocation in
  between is not undone. A record that fails revalidation is revoked, the
  publication is abandoned, and an automatic update becomes `needs-review`,
  so the invariant of §18.7.2 holds.
- **Failure.** If preparation or publication fails, every provisional record
  is revoked on the path that already revokes new approvals
  (`agent-plugin-mcp-runtime.ts:126-133`; the hook runtime's equivalent at
  `agent-plugin-hook-runtime.ts:134-139`). The store ends exactly as before
  the attempt.
- **Both paths implement it:**
  - extensions, in `PluginBundleLifecycle` (`plugin-bundle-lifecycle.ts:136-190`,
    which owns `hookTrust` and `mcpTrust`), feeding
    `plugin-mcp-projection.ts` and `plugin-hook-projection.ts`;
  - agent plugins, in `AgentPluginMcpRuntime.publishOne`
    (`agent-plugin-mcp-runtime.ts:86-137`) and `AgentPluginHookRuntime`
    (`agent-plugin-hook-runtime.ts:101-145`).
- This applies to every update, automatic, reviewed or required.
  Policy-fingerprint approvals are unchanged.

#### 18.7.4 Applying without interrupting a turn

- **Idle gate, boot included.** An automatic or required update starts only
  while `ConversationActivityCoordinator.isBusy()` is false
  (`conversation-activity-coordinator.ts:97-100`). That means no transition
  admission, no session transition, no active turn and no session mutation.
  The gate applies at boot as at any other time. Nothing relies on startup
  order: the main interface loads before `startBackground()` runs, and that
  call is not awaited (`main.ts:514-538`). Right after launch the gate
  normally passes at once.
  - Today only a settled turn notifies (`:112-115`); a mutation completing
    (`:123-129`) and a transition admission released (`:150-152`) notify
    nothing. Slice F adds `onIdle(listener)`, fired whenever `isBusy()`
    becomes false from any of the four conditions.
  - The queue subscribes first and then rechecks `isBusy()`, so an idle
    moment between the check and the subscription is not missed.
  - The gate is read before each package. A turn that starts while a package
    is applying is not blocked; the apply holds no conversation lease.
- **Escalation, not a bound.** A queue that has waited 30 minutes for idle
  publishes a notice: "<n> updates are waiting for the conversation to
  pause", with *Apply now*. *Apply now* is the user's decision and skips only
  the idle gate; leases (below) still protect calls in flight. Without it the
  queue keeps waiting, as long as it takes. Quitting drops the queue, and the
  next boot's apply check classifies again.
- **Extensions restart at the moment their update applies.**
  - The new generation is prepared and started from the verified staging
    tree (`activatePreparedArtifact`, `runtime/index.ts:4789`) and
    published.
  - The old generation retires after its instance leases are released
    (`withPluginInstanceLease`, `runtime/index.ts:3255-3262`) and its HostApi
    operations drain (10 s, `runtime/index.ts:1636`, `:2135-2150`).
  - A call from a routine or sub-agent that starts after publication runs on
    the new generation, with the same authority.
- **Agent-plugin MCP servers and hooks.**
  - **Today.** `publishOne` disconnects the predecessor right after
    publishing the replacement (`agent-plugin-mcp-runtime.ts:135-136`,
    through `mcp-manager.ts:622-627`, `:650-656`). A bundled MCP call takes
    `withBundledLease` (`mcp-manager.ts:1326-1340`), but that asks the
    `generationAccess` boot wires to `PluginBundleLifecycle`
    (`boot.ts:824`), whose coordinator has no agent-plugin generations and
    rejects them (`plugin-generation-coordinator.ts:212-217`). Hooks already
    route `agent-plugin/` owners to the hook runtime's own lease source
    (`script-hook-manager.ts:169-172`, `:542-546`), which counts leases and
    drains per activation (`agent-plugin-hook-runtime.ts:31-39`, `:61-63`).
  - **Owner.** Slice F gives MCP the same shape:
    - `McpManager.registerGenerationLeaseSource(prefix, acquireExact)` is
      added, mirroring the hook manager's.
    - **One acquisition helper.** A private `acquireOwnerLease(owner)`
      routes an owner by the longest registered prefix and falls back to
      `generationAccess`. It replaces **both** direct
      `generationAccess.acquireExact` calls: the one in a registered tool's
      `execute`, which `bindBundledTool` builds (`mcp-manager.ts:1308-1314`)
      for every bundled tool (`:424`, `:471`), and the one in
      `withBundledLease` (`:1326-1340`). Neither keeps its own acquisition.
    - `AgentPluginMcpRuntime` registers `agent-plugin/` and owns its leases:
      a per-activation count and drain waiters, as the hook runtime keeps.
    - **Admission closes** at publication. The old activation is marked
      retired before its servers are unpublished, and `acquireExact` for a
      retired activation throws, as the hook runtime's does
      (`agent-plugin-hook-runtime.ts:34`). A new call therefore lands on the
      new generation.
    - `waitForDrain(activationId)` resolves when the count reaches zero.
  - **Retirement.** The predecessor is disconnected only after its drain,
    replacing the direct disconnect at `:136`. The drain is bounded by each
    call's own tool timeout. The queue also applies an agent plugin only
    while its current activation holds no lease; otherwise the update stays
    `waiting`.
  - **Payload directories are install-addressed, in their own namespace.**
    Today a same-version reinstall, which is what every folder refresh is,
    moves the live version directory aside before activation
    (`content/store.ts:247-249`, `:286-294`) and deletes it with the scratch
    directory (`:306-310`). A server or hook of the old generation then loses
    its paths while it runs. From slice F:
    - every install mints an `installId` (a random UUID) and writes a new
      directory `<root>/<kind>/<name>/.installs/<installId>/`.
      `LedgerEntry.origin` gains `installId` and `payloadDir`. The leading
      `.` keeps this namespace disjoint from legacy version directories,
      because a version directory name must match `SAFE_VERSION`, whose
      first character is a letter or digit (`content/store.ts:173`, `:248`).
      An entry without `payloadDir` is a legacy install and keeps its
      `<version>/` path; no new payload is ever written under a `<version>/`
      directory;
    - nothing that a live generation uses is moved or overwritten;
    - `activation.activate` returns `{ retired: Promise<void> }`. When it
      resolves, the store removes **exactly the retired install's own
      directory**: its `payloadDir` for an install-addressed entry, or its
      `<version>/` for a legacy entry, and a legacy `<version>/` only when
      that legacy install is the one retired. This runs outside the store's
      serialization;
    - a removal that fails, or a quit before it, is cleaned up by the boot
      sweep of §18.7.4's table, which removes a `.installs/<installId>/` no
      ledger entry names and a `<version>/` no legacy ledger entry names.

    The agent-plugin runtime already treats a changed directory as a new
    generation (`agent-plugin-mcp-runtime.ts:105`), so every install is one.
- **Atomic, with defined outcomes.** Each package is its own transaction; a
  pass is not all-or-nothing. Plugins go through `installGitPlugin` and
  `installZipTransaction` (`plugins/marketplace.ts:592`, `:770`); content
  goes through §5.5's install. The pass classifies what those calls throw:

  | Outcome | Where | Installed afterwards | Update state | Attempt counted |
  |---|---|---|---|---|
  | consent deferral | `UpdateNeedsReviewError` at checkpoint two, or a carried approval that fails revalidation | the previous version, untouched | `needs-review` | no |
  | failure before commit | download, verification, prepare, receipt write (`plugins/marketplace.ts:862-878`, `:894`); content activation inside the ledger transaction | the previous version, still running; receipt, registry entry and ledger restored | `failed` with code and detail | yes |
  | publication failure after durable commit | `CommittedPluginGenerationPublicationError` (`committed-generation-publication-error.ts:4-27`), deliberately not rolled back (`plugins/marketplace.ts:899-900`) | the **new** version is committed. `outcome.state: "active"` → it is the active generation; `"inactive"` → installed but not running | `"active"` → `applied`; `"inactive"` → `applied-not-running`. The new baseline is stored | no; there is nothing to install again, and recovery is the runtime's (the next boot activates the committed generation) |
  | retirement or cleanup failure | old generation retirement (`PluginRetirementJournal`), the old content directory | the new version, active | `applied`; the failure is logged | no; plugin retirement resumes from its journal at boot (`recoverRetirements`, `plugin-bundle-lifecycle.ts:280-297`), and slice F adds a boot sweep that removes content payload directories no ledger entry names |
  | success | — | the new version, active | `applied`, or `approval-pending` for a required install that left a component unapproved (§18.7.2) | — |

  The displayed installed version always comes from the committed receipt or
  ledger entry, never from the attempt's target.
- **Order**: plugins in dependency order (`dependency-resolver.ts`), then the
  rest by key, one package at a time.

#### 18.7.5 Status, failures, offline, skips and revocations

Each state below is a member of `UpdateStatusView.packages[].state` (§18.9);
the table and the type list the same eight.

| State | Meaning | Shown |
|---|---|---|
| `automatic` | applies at this apply check | Updates card while running |
| `waiting` | automatic or required, waiting for idle or for an agent plugin's calls (§18.7.4) | Updates card, package row; after 30 minutes the notice with *Apply now* |
| `needs-review` | fingerprint differs, a field is `unknown`, a previously approved component would not keep its approval, or checkpoint two deferred it (§18.7.3) | pill, Updates card, row, *Review* |
| `manual` | automatic updates off for it | pill (while update notices are on), row, *Update* |
| `failed` | last attempt failed before commit: `code`, `detail`, `attempts` | pill, Updates card, row, *Retry*, *Details* |
| `applied` | installed by an automatic or required update | the notice under "Updated automatically", the card's recent list |
| `applied-not-running` | committed, but its generation did not start (§18.7.4) | pill, row "installed, not running — restart Ave" |
| `approval-pending` | a required update installed with an MCP server or hook unapproved, so that component is not running (§18.7.2) | pill, row, and right after the install a notice "<name> was updated by your organization; <n> components need your approval" with *Review* |

`skipped` is not a state of the view: a skipped version is neither applied
nor shown, and the next version is.

- **Review for `approval-pending`** reuses the existing approval surfaces:
  - **Both surfaces bind the approval to what was reviewed.** A review
    shows one installed generation; a required update can replace it before
    the user submits, and a component digest alone does not cover the whole
    package tree (`agent-plugin-components.ts:57-73`). So every approval
    request carries the reviewed generation and, for each component, the
    `approvalDigest` the review showed (`string | null`, §18.7.3). The
    handler re-validates both against the installed generation **under the
    serialization that installs and publications take**, before it approves
    anything. On any mismatch it approves nothing and fails `PLAN_EXPIRED`
    reason `package-changed` (§18.8): "This package changed since you
    reviewed it. Review it again." The review then reloads. A component
    whose digest is `null` binds by generation alone: the reviewed
    generation (an agent plugin's `installId`, an extension's artifact
    generation id) must equal the installed one exactly, and it names
    exactly one artifact (below).
  - **extensions**: *Review* opens the plugin's trust rows in
    `PluginConfigTab.tsx`. That tab lists through
    `ave:plugins:contribution-trust:list` and approves through
    `ave:plugins:contribution-trust:set` (`ipc/domains/plugins.ts:541-589`,
    preload `internal-api-surface.ts:527-534`). The existing request is
    extended; no parallel channel is added:
    - list rows (`PluginContributionTrustRow`,
      `plugin-bundle-lifecycle.ts:141-149`) gain `approvalDigest`. Their
      `generationId` is already the projection's `owner.generationId`,
      which the projections set from the **artifact** generation id
      (`artifactGenerationId`, `plugin-mcp-projection.ts:206-212`,
      `plugin-hook-projection.ts:78`), not the coordinator's generation id;
    - a `set` request with `approved: true` must carry `generationId` and
      `approvalDigest` from the row it shows; without them the handler
      returns `invalid-contribution-trust-request` (`plugins.ts:573`). A
      revoke (`approved: false`) takes neither, because a revoke only
      narrows trust;
    - `approveHook` and `approveMcpServer` take that binding, and
      `updateHookTrust`/`updateMcpTrust` check it inside
      `serialize(pluginId)` (`plugin-bundle-lifecycle.ts:355-357`,
      `:383-385`), the serialization a new generation's publication takes:
      the active projection's `owner.generationId`, which is the active
      generation's `artifactGenerationId`, must equal `generationId`, and
      the projection's approval digest must equal `approvalDigest`. The
      coordinator's generation id (`generation.generationId`) also hashes
      `runtime.activationId` (`plugin-bundle-lifecycle.ts:546-551`), so it
      changes when the same artifact is activated again; it stays the
      activation identity (`owner.activationId`) and is never compared. The
      artifact generation id hashes `plugin.json` and the install receipt
      (`:546`), so it identifies the reviewed artifact. A mismatch returns
      `contribution-trust-review-stale`, which the tab shows with the same
      catalog sentence and then reloads its rows.
    - an extension's `approval-pending` entry in `UpdateStatusView` carries
      no `pendingApproval`: its review reads the trust list above.
  - **agent plugins**: *Review* opens the update review (§15.6) in
    component mode, showing the `consentDelta` rows of the unapproved
    components, from the package's `pendingApproval` in `UpdateStatusView`
    (§18.9), which is present exactly for an agent plugin's
    `approval-pending` entry. Its approve action calls the new channel
    `ave:marketplace:components:approve`
    `(key, installId, consents: ReviewedComponentConsent[])`, where each
    consent is the existing `ComponentConsent`
    (`shared/git-marketplace.ts:400-412`) plus the `approvalDigest` shown.
    The handler is in `ipc/domains/git-marketplace.ts`. The service passes
    the call to the content store, which, inside its install serialization
    (`content/store.ts:253`), checks that the ledger entry's
    `origin.installId` equals `installId` and that each named component's
    approval digest, computed from that entry's `payloadDir`, equals the
    consent's. Only then does it call `AgentPluginMcpRuntime.activate` and
    `AgentPluginHookRuntime.activate` with those consents on the installed
    generation (`agent-plugin-mcp-runtime.ts:139-142`,
    `agent-plugin-hook-runtime.ts:144-146`). Those methods already approve
    and publish under their serialization, and still check each consent's
    component digest (`agent-plugin-mcp-runtime.ts:91-97`). An `installId`
    names exactly one payload directory, and nothing in it is overwritten
    (§18.7.4).
  - The state clears when no component of the installed generation is
    unapproved.
- **Offline**: when every source fails `SOURCE_UNREACHABLE` reason `offline`,
  the discovery result is `offline`, nothing applies, and the card reads
  "Offline — last checked <time>". The next hourly due check retries
  (§18.7.1).
- **A source fails**: its packages sit out this pass. The Sources row shows
  the status with its detail (§18.8), and package rows say "Source
  unreachable — showing the installed version".
- **An update fails before commit**: the previous version stays. The state is
  `failed` with code, detail and attempt count, and it is retried at the next
  apply check. After three failed attempts for one version, automatic
  attempts stop for it until a newer version or *Retry*; required installs
  excepted (§18.7.2). Consent deferrals and failures after commit are not
  attempts (§18.7.4's table).
- **Applied**: listed once in the notice (§15.1) under "Updated automatically"
  with versions and *What changed* (§15.6's commit range);
  `BootInstallNoticeView` (`shared/git-marketplace.ts:373-384`) gains
  `autoUpdated`.
- **Pill** (`PluginUpdatesPill.tsx`) counts only updates that need the user:
  `needs-review`, `failed`, `applied-not-running`, `approval-pending`, and
  `manual` while update notices are on. `updateCheckEnabled` keeps its
  meaning (whether notices reach the renderer) and does not switch automatic
  updates.
- **Rollback**: installing an older listed version by hand (§16.2) records the
  version it left as skipped, so the next pass does not undo it.
- **Revocations** are enforced at every discovery, before any update,
  whatever the settings. An update never targets a revoked version (§6.1
  step 6). A revocation-disabled package is not updated automatically; its
  notice offers the update with one click into the review.

#### 18.7.6 Folder sources

A folder package has an update when its source's revision changed and its
tree digest differs from the installed `artifactSha256` (plugin) or
`contentSha256` (content).

- A higher declared version is an upgrade.
- An equal version is a **refresh**, which applies like an upgrade.
- A lower version is a downgrade, offered by hand only.

The default is on (§18.7.2), and consent (§18.7.3) applies unchanged.

### 18.8 Messages: every refusal, warning and failure

Today `failureText` (`labels.ts:103-118`) has a sentence for nine codes and
prints `CODE · <main's English message>` for every other (`:116`). From 0.13.0:

- `MarketplaceError` (`errors.ts:44-53`) gains an optional `detail`: a union
  keyed by code, with a `reason` and the values the sentence needs (host,
  address, path, pattern, ref, version). The envelope becomes
  `{ ok: false, code, message, detail? }` (`shared/git-marketplace.ts:393`);
  `parseGitMarketplaceResult` (`:456`) keeps a `detail` whose `reason` it knows
  for the code and drops any other.
- **The Sources status carries the detail too**, because a background sync's
  failure reaches the UI through a successful `sources:list`, not through a
  failed envelope:
  - `SyncResult`'s failed variant gains `detail?`;
  - `recordFailure` (`sources/sync.ts:129-133`) persists it in
    `SourceState.lastSync.detail` (`sources/registry.ts:56`);
  - the state validator accepts a `detail` only when its reason belongs to
    the code, and drops any other while keeping the code;
  - `sourceStatus` (`app/views.ts:169-179`) copies it into the `unreachable`
    and `auth-required` views.
- `failureText` becomes exhaustive over `GitMarketplaceErrorCode` and each
  reason (`never` check, no `default`). Every code also has a reason-less
  sentence, used when `detail` is absent: an older state file, or a dropped
  detail. A test enumerates `MARKETPLACE_ERROR_CODES` and every reason and
  fails when one has no catalog sentence. Main's English `message` shows only
  behind *Copy details*.
- One component, `MarketplaceProblem`, renders three tones: **policy** (lock,
  "Set by your organization", the rule, the policy file path, no *Continue*),
  **warning** (amber, the risk, *Continue* / *Cancel*), **error** (red, what
  happened, the action).
- Keys: `gitMarketplace.error.<code>.<reason>`, `gitMarketplace.warning.<warning>`,
  `gitMarketplace.policy.<reason>`, `gitMarketplace.action.<action>`. The
  existing `gitMarketplace.error.policyBlocked` stays the MCP governance
  sentence (`PACKAGE_POLICY_BLOCKED`); source policy blocks use
  `gitMarketplace.policy.*`, so the two never mix.
- Korean uses the catalogs' formal register (`-습니다`, `-하세요`). A warning
  ends in a question ("계속할까요?"). A policy sentence names the organization as
  the cause ("조직 정책이 …"), never the user.

Class: **P** policy block, **W** warning, **R** refusal, **E** fixable error,
**S** status. Every row carries what happened, why, and the next action; the
exact English and Korean text is written through the i18n generator (§15.9) in
the slice that adds the code or reason.

| Code · reason | Class | What happened, and why | Next action | Korean direction |
|---|---|---|---|---|
| `SOURCE_POLICY_BLOCKED` · `blocked-by-pattern` | P | "Your organization blocks <target> (rule `<pattern>`)." | "Ask your administrator. The rule is in <policy path>." | "조직 정책이 <대상>을 차단합니다(규칙 `<pattern>`). 관리자에게 문의하세요." |
| · `not-in-allow-list` | P | "Your organization allows only listed sources; <target> is not listed." | as above | "조직 정책이 허용한 소스만 쓸 수 있고, <대상>은 목록에 없습니다." |
| · `https-required` | P | "Your organization requires https; <target> uses http." | "Use the https address, or ask your administrator to list the host." | "조직 정책상 https만 쓸 수 있습니다." |
| · `private-network-blocked` | P | "Your organization blocks sources on internal networks and on this computer." | as above | "조직 정책이 사내망과 이 컴퓨터의 소스를 막습니다." |
| · `local-sources-blocked` | P | "Your organization does not allow folders as sources." | as above | "조직 정책이 폴더 소스를 허용하지 않습니다." |
| · `direct-install-blocked` | P | "Your organization allows installs from marketplaces only." | as above | "조직 정책상 마켓플레이스를 거쳐서만 설치할 수 있습니다." |
| · `policy-invalid` | P | "The organization's marketplace policy cannot be read (<error>), so only the official marketplace works." | "Ask your administrator to fix <policy path>." | "조직의 마켓플레이스 정책을 읽을 수 없어 공식 마켓플레이스만 동작합니다." |
| `PACKAGE_POLICY_BLOCKED` | P | today's sentence (MCP governance) | "Ask your administrator." | today's |
| `PACKAGE_REQUIRED_BY_POLICY` | P | "Your organization requires <name>, so it cannot be removed or turned off." | — | "조직이 <이름>을 필수로 지정해 제거하거나 끌 수 없습니다." |
| `SOURCE_CONFIRMATION_REQUIRED` · `unencrypted` | W | "<host> uses http: the connection is not encrypted, so anyone on the network path can see and change what you download." | "Continue?" | "…암호화되지 않습니다. 계속할까요?" |
| · `token-unencrypted` | W | "Your sign-in for <host> would travel unencrypted, and anyone on the path could copy it." | "Continue?" | "로그인 정보가 암호화되지 않은 채 전송됩니다. 계속할까요?" |
| · `internal-network` | W | "<host> is on an internal network (<address>). This allows only this source's own server; downloads the marketplace points at other internal hosts are asked separately." For `198.18.0.0/15`, adds "Some proxy tools report every address in this range." | "Continue only if you expect this source inside your organization's network." | "<호스트>는 사내망 주소(<주소>)입니다. 이 소스의 서버만 허용하며, 다른 사내 호스트에서 내려받는 것은 따로 묻습니다. 조직 내부 소스가 맞을 때만 계속하세요." |
| · `this-computer` | W | "<host> is this computer (<address>)." | "Continue only if you run this server yourself." | "<호스트>는 이 컴퓨터입니다. 직접 실행한 서버일 때만 계속하세요." |
| · `internal-downloads` | W | "<source> asks Ave to download from <host>, another internal address. A marketplace that can name internal hosts can make Ave send requests into your network, for example to a router's settings page; a later failed check cannot undo a request already sent." | *Allow internal downloads* | "마켓플레이스가 다른 사내 주소 <호스트>에서 내려받게 합니다. 이렇게 하면 마켓플레이스가 Ave를 통해 사내망 장비로 요청을 보낼 수 있고, 보낸 요청은 되돌릴 수 없습니다. 허용할까요?" |
| · `network-folder` | W | "Ave signs in to <server> with your Windows account to read this folder." | "Continue?" | "이 폴더를 읽으려고 Windows 계정으로 <서버>에 로그인합니다. 계속할까요?" |
| · `unencrypted-updates` | W | "Updates from <source> arrive over http. Anyone on the network path could replace them with their own code, and it would install without asking." | "Turn on automatic updates anyway?" | "…묻지 않고 설치될 수 있습니다. 그래도 자동 업데이트를 켤까요?" |
| `SOURCE_URL_REJECTED` · `credentials-in-url` | R | "The address contains a password or token. Ave never keeps secrets in addresses." | "Remove it from the address, then choose *Access token* under *Sign-in* and paste the token there." | "주소에서 빼고, 로그인에서 액세스 토큰을 골라 그곳에 붙여 넣으세요." |
| · `helper-transport` | R | "`<scheme>::` addresses run a program to fetch; Ave never runs one." | "Use the https or ssh address." | "`<scheme>::` 주소는 프로그램을 실행하므로 쓸 수 없습니다." |
| · `scheme-unsupported` | R | "Ave does not read `<scheme>:` addresses." | "Use the https or ssh address of the same repository." | "같은 저장소의 https나 ssh 주소를 쓰세요." |
| · `format` | R | "The address has `?…`, `#…`, spaces or control characters." | "Remove them." | "주소에서 해당 문자를 지우세요." |
| · `relative-path` | R | "A relative path cannot be read here." | "Enter a full path, or use *Choose folder…*." | "전체 경로를 입력하거나 폴더 선택을 쓰세요." |
| · `device-path`, `windows-path`, `network-file-url` | R | the form, and why it is not a folder | "Enter the folder's normal path." | "폴더의 일반 경로를 입력하세요." |
| · `index-file-url` | R | "Ave reads a marketplace as a repository or a folder, not a single marketplace.json." | "Enter the repository address instead." | "marketplace.json 파일이 아니라 저장소 주소를 입력하세요." |
| · `address-metadata` | R | "<host> resolves to <address>, a link-local or cloud-metadata address. No marketplace lives there, and requests to it can expose this computer's credentials." | "Check the address and your network settings." | "…이 컴퓨터의 자격 증명이 노출될 수 있어 연결하지 않습니다." |
| · `address-unroutable` | R | "<address> cannot be reached from any network." | "Check the address." | "어느 네트워크에서도 닿을 수 없는 주소입니다." |
| · `catalog-this-computer` | R | "<source> points a download at this computer (<host>). A marketplace may not send requests to services on your computer." | "Tell the marketplace's owner." | "마켓플레이스가 이 컴퓨터의 서비스로 요청을 보내게 할 수 없습니다." |
| · `deep-link-path` | R | "A link cannot choose a folder on this computer." | "Choose the folder yourself." | "링크로는 폴더를 지정할 수 없습니다. 직접 선택하세요." |
| `CONTENT_RULE_VIOLATION` · `link-outside-folder` | R | "<path> links outside the folder (to <target>). Ave installs files from inside the folder only." | "Copy the file into the folder instead of linking it." | "폴더 밖을 가리키는 링크는 설치하지 않습니다. 파일을 폴더 안으로 복사하세요." |
| · `link-to-network` | R | "<path> links to a network location (<target>). Ave does not follow links to other computers." | "Copy the file into the folder instead of linking it." | "다른 컴퓨터를 가리키는 링크는 따라가지 않습니다. 파일을 폴더 안으로 복사하세요." |
| · `link-to-skipped` | R | "<path> links into <target>, which Ave never reads (version-control data or system files)." | "Copy the file into the folder instead of linking it." | "Ave가 읽지 않는 항목을 가리키는 링크입니다. 파일을 폴더 안으로 복사하세요." |
| · `special-file`, `case-collision`, `extension`, `limit` | R | the path and the rule (§5.4, §5.5) | "Remove or rename <path>." | "<경로>를 지우거나 이름을 바꾸세요." |
| `SOURCE_AUTH_REQUIRED` · `token` | E | "<host> needs sign-in." | a token source: *Set token…* on its row (a stored token: "<host> did not accept the stored token", *Set token…* to replace it); added without a token: *Remove source*, then add again with *Access token*; organization without a token: "Tell your administrator"; an address being typed: *Access token* under *Sign-in*; for GitHub "a fine-grained token with read access to Contents" | "<호스트>에 로그인이 필요합니다." |
| · `token-no-access` | E | "<host> reports no repository at this source's address to the token stored for <host>, so the token may lack access to it." | *Set token…* to replace it; a source the user added: or *Remove source* and add it again if the address is wrong | "토큰에 이 저장소 권한이 없을 수 있습니다." |
| · `token-unencrypted` | E | "<host> needs sign-in, and this source uses http." | *Allow…* (`token-unencrypted`), then *Set token* | "http 소스라 로그인 정보를 보내기 전에 허용이 필요합니다." |
| · `ssh` | E | "<host> refused the SSH key." | "Load your key (`ssh-add`) or add it to your account on <host>." | "SSH 키가 거부되었습니다." |
| `SOURCE_SSH_HOST_UNKNOWN` · `unknown` | E | "This computer has not connected to <host> over SSH before, so its key cannot be checked." | "Compare the host's published fingerprint, then run `ssh-keyscan -p <port> <host> >> ~/.ssh/known_hosts` (Windows: `%USERPROFILE%\.ssh\known_hosts`)." *Copy command* | "호스트 키를 확인할 수 없습니다. 지문을 확인한 뒤 명령을 실행하세요." |
| · `changed` | E | "<host>'s SSH key changed. A reinstalled server does this, and so does someone intercepting the connection." | "Confirm with the server's administrator, then `ssh-keygen -R <host>`." | "서버 재설치나 중간자 공격일 수 있습니다. 관리자에게 확인하세요." |
| `SOURCE_REF_NOT_FOUND` | E | "`<ref>` is not a branch or tag of <repository>." | "Available: <up to 10>. Leave the field empty for the default branch." | "브랜치나 태그가 없습니다." |
| `SOURCE_UNREACHABLE` · `offline` | E | "This computer is offline." | "Ave tries again when the network is back." | "오프라인입니다." |
| · `dns` | E | "<host> could not be found." | "Check the address, or your VPN." | "주소나 VPN을 확인하세요." |
| · `refused`, `timeout`, `http-status` | E | "<host> did not answer (<detail>)." | *Retry* | "응답이 없습니다." |
| · `tls` | E | "The certificate of <host> is not trusted. Company networks often re-sign traffic." | "Ask IT to install the network's root certificate in the system store; Ave reads it (§9.2)." | "회사 네트워크가 인증서를 바꾸는 경우가 많습니다. IT에 루트 인증서 설치를 요청하세요." |
| · `proxy` | E | "The system proxy settings choose <kind> for <host>, which Ave cannot use." | "Ask IT for an HTTP proxy or a direct route to <host>." | "쓸 수 없는 프록시 종류입니다." |
| · `not-found` | E | "<host> reports no repository at this address, which is also how hosts answer for a private repository without sign-in." Never claims either. | a token source without a stored token: *Set token…* (a source the user added: or *Remove source* if the address is wrong; an organization source: otherwise the administrator); with a stored token: as `SOURCE_AUTH_REQUIRED` · `token-no-access`; added without a token: *Remove source* and add again with the right address or *Access token*; organization without a token: "Tell your administrator"; an address being typed: "Check the address", or *Access token* | "<호스트>가 이 주소에 저장소가 없다고 답했습니다. 비공개 저장소에도 같은 답을 합니다." |
| · `not-found-ssh` | E | "<host> reports no repository at this address over SSH, which is also how hosts answer when your SSH key's account cannot read a private repository." | "Make sure your key is loaded (`ssh-add`) and belongs to an account on <host> that can read the repository"; plus the address advice for an address being typed or a source the user added, the administrator for an organization source | "SSH 키의 계정이 읽을 수 없는 비공개 저장소에도 같은 답을 합니다." |
| `SOURCE_LOCAL_UNREADABLE` · `not-found` | E | "The folder <path> does not exist: moved, renamed, or its drive is not connected." | "Reconnect the drive, or remove the source and add the folder again." | "폴더가 없습니다." |
| · `permission`, `io` | E | "<path> cannot be read (<system message>)." | "Check the folder's permissions; Ave tries again at the next read." | "폴더를 읽을 수 없습니다." |
| · `moved` | E | "<path> now points to <new path>." | "Remove the source and add the folder you mean." | "폴더가 다른 곳을 가리킵니다." |
| · `not-a-directory` | E | "<path> is not a folder." | "Choose a folder." | "폴더를 선택하세요." |
| · `ambiguous-case` | E | "<path> matches several folders that differ only in case." | "Enter the path with its exact case." | "대소문자만 다른 폴더가 여럿입니다. 정확한 대소문자로 입력하세요." |
| · `changed-during-read` | E | "A file in <path> changed while Ave read it." | "Ave tries again at the next read." | "읽는 중에 파일이 바뀌었습니다." |
| · `classifier-unavailable` | E | "Ave cannot tell whether <path> is on another computer because its folder classifier is missing or broken." | "Reinstall Ave." | "폴더 분류 도구가 없거나 손상되었습니다. Ave를 다시 설치하세요." |
| `SOURCE_NOT_A_MARKETPLACE` · `nothing-found` | E | "No marketplace.2.json, no package folders and no single package at <location>." | an address being typed: "Check the address, the branch and, for a package inside a repository, the folder field."; a source the user added: the same, through *Remove source* and adding it again; official: *Refresh* later, then the marketplace's owner; organization: "Tell your administrator" | today's key, with the location |
| · `other-app-plugin` | E | "This is a plugin written for another app (`.claude-plugin/` or `.codex-plugin/`)." | "Use *Import a plugin* in the plugin studio (`extensions-and-plugins.md` §2.4)." | "다른 앱용 플러그인입니다. 플러그인 스튜디오에서 가져오세요." |
| `SOURCE_INDEX_INVALID` | E | "<source>'s index is invalid (<file>: <problem>); the last good version stays in use." | "Tell the marketplace's owner." *Copy details* | "마지막 정상 버전을 계속 씁니다." |
| · `name-reserved-prefix`, `version-reserved-prefix`, `component-reserved-prefix` | E | "Package names starting with “<prefix>”, or with a part after “-” starting with it, are reserved because they look like <issuer>, so Ave does not offer this package." / "Versions with a part starting with “<prefix>” are reserved…" / "A skill, agent, prompt, routine or MCP server in this package has a name with a part starting with “<prefix>”. Such names are reserved…" | "Ask the package's author to choose a different name / change the version." | "“<접두사>”로 시작하거나 “-” 뒤 부분이 그것으로 시작하는 패키지 이름은 <발급자>처럼 보여 예약되어 있으므로…" |
| · `name-holds-credential`, `version-holds-credential`, `component-holds-credential` | E | "This package's <name / version> looks like a password or token, so Ave does not offer it." / "A skill, agent, prompt, routine or MCP server in this package has a name that looks like a password or token, so Ave does not offer it." | "Ask the package's author to <rename / change> it." | "이 패키지의 이름이 비밀번호나 토큰처럼 보여 Ave가 제공하지 않습니다." |
| `SOURCE_HISTORY_REWRITTEN` | E | official, managed: "<source>'s history was rewritten; Ave keeps its last good version." custom, direct: "…Review the new history before using it." | custom, direct: *Review* | "기록이 다시 쓰였습니다." |
| `SOURCE_DISABLED` | E | today's sentence | *Show source* | today's |
| `SOURCE_LOCAL_DATA_DAMAGED` · `state-missing`, `state-invalid`, `state-unreadable` | W | "The downloaded copy of source <id> is damaged: <its record of the trusted version is missing, unreadable, or cannot be opened>." | "Repair downloads it again and trusts the version the source serves now, without checking it against the one you had." *Repair* on the row (every origin), in place of Refresh and the switch; for `state-unreadable`, fixing the folder's permissions keeps the check; *Copy details* | "복구하면 이전 버전과 대조하지 않은 채 지금 제공되는 버전을 신뢰합니다. 소스에서 복구를 누르세요." |
| · `snapshot-invalid`, `snapshot-unreadable`, `repository-damaged` | E | "The downloaded copy of source <id> is damaged: <its package list or its git repository>." | *Repair*; "the version Ave trusts is kept" | "Ave가 신뢰하는 버전은 유지됩니다." |
| · `repair-failed`, `repair-failed-unpinned` | E | "Ave could not move the damaged copy of the <source> source aside, so it was not downloaded again", adding "the version Ave trusts is kept" only for `repair-failed`. | "Quit other Ave windows and choose Repair again"; *Copy details* for the administrator | "다른 Ave 창을 닫고 복구를 다시 누르세요." |
| · `repair-write-failed` | E | "Ave could not save the <source> source's record of the version it trusts, so the source was not downloaded again." | "Check the free disk space and that your account can write the Ave data folder, then choose Repair again." | "디스크 공간과 쓰기 권한을 확인한 뒤 복구를 다시 누르세요." |
| `SOURCE_LIST_UNREADABLE` · `unreadable`, `invalid` | E | "Ave cannot read the list of sources you added, `marketplaces/sources.json` in the Ave data folder (<fsCode>, or not in the format Ave writes), so it changes no source until it is fixed." | "Fix the file or delete it, then restart Ave. Deleting it removes only the sources you added: the official and organization sources and your installed packages stay." *Copy details* for an invalid file | "직접 추가한 소스 목록(Ave 데이터 폴더의 marketplaces/sources.json)을 읽을 수 없습니다. 고치거나 지운 뒤 Ave를 다시 시작하세요. 지우면 직접 추가한 소스만 사라집니다." |
| `SOURCE_NAME_RESERVED`, `SOURCE_ID_INVALID` | E | "<id> is reserved or not a valid id (2–63 lowercase letters, digits and `-`)." | "Choose another id." | "다른 ID를 고르세요." |
| · `reserved-prefix` | E | "Ids starting with “<prefix>”, or with a part after “-” starting with it, are reserved because they look like <issuer>." (also under the Add dialog's id as it is typed) | "Choose a different id." | "“<접두사>”로 시작하거나 “-” 뒤 부분이 그것으로 시작하는 ID는 <발급자>처럼 보여 예약되어 있습니다." |
| · `holds-credential` | E | "This id looks like a password or token, so it cannot be used." | "Choose another id." | "이 ID는 비밀번호나 토큰처럼 보여 쓸 수 없습니다." |
| · `stored-id-holds-credential` | E | "This source's id looks like a password or token, so Ave does not sync it or offer its packages." | "Remove the source and add it again with another id." (the row offers only Remove) | "이 소스의 ID가 비밀번호나 토큰처럼 보여 Ave가 동기화하거나 패키지를 제공하지 않습니다." |
| `SOURCE_ID_TAKEN` | E | "<id> is taken" | "Choose another id." | "다른 소스가 이미 쓰는 ID입니다." |
| · `repository-already-added` | E | "<url> is already added as <id>" | "Use <id>, or remove it" (before adding the repository again); *Show <id>* | "<url>은(는) 이미 <id>(으)로 추가되어 있습니다." |
| · `folder-already-added`, `folder-inside-source`, `folder-contains-source` | E | "<path> is already added as <id>" / "<path> lies inside <existing path>, which is already added as <id>" / "<path> contains <existing path>, which is already added as <id>" | "Use <id>, or remove it" (and add the folder you want, or one that does not contain it); *Show <id>* | "이미 <id>(으)로 추가된 폴더와 겹칩니다. <id>을(를) 쓰거나 지우세요." |
| `GIT_RUNTIME_MISSING`, `GIT_RUNTIME_TOO_OLD` | E | today's sentences | *Install Git* | today's |
| `GIT_RUNTIME_INSTALL_FAILED` · `<phase>` | E | "Installing git failed while <phase> (<reason>)." | *Retry*; "If your network blocks GitHub downloads, install git yourself and choose *System*." | "git 설치가 <단계>에서 실패했습니다." |
| `PLAN_EXPIRED` · `expired`, `replaced`, `folder-changed`, `policy-changed`, `package-changed` | E | today's; for a folder "The folder changed while you were reviewing."; for policy "Your organization's policy changed while you were reviewing."; for `package-changed` (an approval of §18.7.5 whose reviewed generation or approval digest no longer matches) "This package changed since you reviewed it. Review it again." | the review reopens with a fresh plan, or with the installed generation for `package-changed` | today's; "검토하는 사이 조직 정책이 바뀌었습니다."; "검토한 뒤 패키지가 바뀌었습니다. 다시 검토하세요." |
| `PACKAGE_INCOMPATIBLE` · `min_app_version` / `platform` / `prerelease` / `rollout` / `host_protocol` | E | "<name> needs Ave <version>" / "not available for <OS>" / "only pre-releases exist" / "rolling out gradually; offered to you later" / "needs a newer plugin protocol" | *Update Ave* / — / "Turn on pre-releases under Updates" / — / *Update Ave* | reason by reason |
| `PACKAGE_COMPAT_UNDECLARED` | E | "The plugin does not declare which Ave version it needs (`requires.minAppVersion`)." | "Ask its author to declare it." | "필요한 Ave 버전을 선언하지 않았습니다." |
| `PACKAGE_YANKED`, `PACKAGE_REVOKED` | E | "Withdrawn by <source>: <reason>." | "Choose another version, or uninstall." | "<소스>가 철회했습니다." |
| `PACKAGE_ID_CONFLICT` | E | "<name> is installed from <other source>." | *Switch to <source>* (its data stays, §15.1) | today's key |
| `ARTIFACT_NOT_PINNED` | S | rung list: "The marketplace did not pin this download, so it was skipped." | — | "고정되지 않은 다운로드라 건너뛰었습니다." |
| `ARTIFACT_DIGEST_MISMATCH` | E | "The download from <host> is not the file the marketplace pinned; nothing was installed from it." | "Try again later; tell the owner if it persists." | "고정된 파일과 다릅니다." |
| `MANIFEST_MISMATCH` · `<field>` | E | "The package's files disagree with its marketplace entry (<field>), so nothing was installed." | "Tell the marketplace's owner." *Copy details* | "파일과 마켓플레이스 항목이 다릅니다." |
| `NO_INSTALLABLE_ARTIFACT` · `rungs`, `folder-has-no-build` | E | "No download for <name> could be used:" and each rung's sentence; for a folder "The folder has no built plugin (`plugin.json` and `dist/`)." | the first rung's action; for a folder "Build into `dist/`, or add the git repository instead." | "쓸 수 있는 산출물이 없습니다." |
| `process-entry-unsupported` (on `main` today, `errors.ts:37`; removed by P3) | E | today's sentence (`labels.ts:114`, `formatIpcError.processEntryUnsupported`): this version does not run plugins that start their own process | "Use a version of the plugin without a separate process, or wait for an Ave update." | today's |
| `process-entry-requires-pinned-artifact` (added by P3) | E | "This extension runs a program, which Ave installs only from a release pinned by its marketplace." | "Install it from a marketplace that pins its release." | owned by the Publication plan |
| `process-entry-unconfined` (added by P3) | E | owned by the Publication plan (its runtime refusal) | owned by the Publication plan | owned by the Publication plan |
| `invalid-request` | E | "Ave sent a request this version does not understand. This is a bug." | *Copy details* | "버그입니다." |
| `unavailable` | E | "The marketplace could not start or answer." Main's message is not shown, as for every code; it is behind *Copy details*, scrubbed. The Updates card says "Update checks are not available right now." instead (§15.7.1). | "Restart Ave; if it persists, *Copy details*." | "마켓플레이스가 시작하거나 응답하지 못했습니다." |
| `unauthorized-frame` | — | never shown: audited, no displayable answer | — | — |
| update `needs-review` | S | "<name> <version> asks for more than the installed version:" and each `consentDelta` row. When only non-code files changed: "Only these non-code files changed:" and the list. For a migrated approval: "Approval from an earlier Ave version must be confirmed." | *Review*; for non-code changes *Approve update* | "설치된 버전과 권한·구성이 다릅니다. 검토하세요." / "코드가 아닌 파일만 바뀌었습니다." |
| update `approval-pending` | S | "<name> was updated by your organization; <n> components need your approval and are not running." | *Review* | "조직이 <이름>을 업데이트했고, 구성 요소 <n>개가 승인을 기다리며 실행되지 않습니다." |
| update `waiting` | S | "Waiting for the conversation to pause." After 30 minutes, as an escalation: "<n> updates are waiting for the conversation to pause." | after 30 minutes, *Apply now* | "대화가 멈추면 적용합니다." |
| update `failed` | S | the failure's sentence and "Attempt <n> of 3" | *Retry*, *Details* | "<n>/3회 실패" |
| update `applied-not-running` | S | "<name> <version> is installed but did not start." | "Restart Ave." | "설치했지만 시작하지 못했습니다. Ave를 다시 시작하세요." |
| discovery `offline` | S | "Offline — last checked <time>." | "Ave checks again when the network is back." | "오프라인 — 마지막 확인 <시각>" |

### 18.9 Settings, IPC, preload, lock suites and UI

**Settings** — `MarketplaceSettings` (`settings-store.ts:893-959`),
`normalizeMarketplace` (`settings-normalization.ts:921`):

| Key | Type | Default | Notes |
|---|---|---|---|
| `autoUpdate` | `boolean` | unset = `true` | global switch |
| `autoUpdateSources` | `Record<sourceId, "on" \| "off">` | unset | invalid ids (`SOURCE_ID_RE`) or values dropped by the normalizer; null-prototype map |
| `autoUpdatePackages` | `Record<string, "on" \| "off">` | unset | keyed by `packageUpdateSkipKey`, normalized with `normalizeSkippedPluginUpdateKey` |
| `updateCheckIntervalMs` | `number` | unset = 6 h | unchanged: the discovery interval (§18.7.1); `0` and the 15-minute floor unchanged. The 24-hour apply cadence is not a setting |
| `updateCheckEnabled`, `skippedPluginUpdates` | — | — | unchanged |

The renderer writes these through the existing settings channel. The http
precondition is **not** a setting: it is the source confirmation
`unencrypted-updates`, recorded only by main.

**IPC and preload** — every new channel is host-renderer only
(`validateHostRendererSender`) and audited (§13).

| Channel | Change | Request | Response |
|---|---|---|---|
| `ave:marketplace:sources:preview` | changed | `SourcePreviewRequest` (`shared/git-marketplace.ts:73-82`) gains `acknowledge?: SourceWarning[]`; `input` also takes a folder | union gains `{ type: "confirm"; warnings: SourceWarningView[] }` |
| `ave:marketplace:sources:list` | changed | — | `SourceStatusView` `unreachable` and `auth-required` gain `detail?` (§18.8) |
| `ave:marketplace:sources:acknowledge` | new | `(id, warnings: SourceWarning[])` | `SourceView`, after a sync |
| `ave:marketplace:sources:pick-folder` | new | `()`; main shows the folder dialog and keeps the path | `{ pick; display } \| null` |
| `ave:marketplace:sources:reveal` | new | `(id)`; folder sources only — an id, never a path | `null` |
| `ave:marketplace:updates:status` | new | `()` | `UpdateStatusView` |
| `ave:marketplace:updates:check` | new | `()`; joins a discovery in flight | `UpdateStatusView` when that discovery and its apply check end (§18.7.1) |
| `ave:marketplace:updates:apply-now` | new | `()`; skips the idle gate for the queue (§18.7.4) | `UpdateStatusView` |
| `ave:marketplace:install:execute` | changed | component consents accepted for `plugin` too (§18.7.3) | — |
| `ave:marketplace:components:approve` | new | `(key: PackageKeyView, installId: string, consents: ReviewedComponentConsent[])`; agent plugins in `approval-pending`; re-validated against the installed generation (§18.7.5) | `UpdateStatusView`; `PLAN_EXPIRED` reason `package-changed` on a mismatch |
| `ave:plugins:contribution-trust:list` | changed | — | each row gains `approvalDigest: string \| null` (§18.7.5) |
| `ave:plugins:contribution-trust:set` | changed | with `approved: true`, also `generationId` and `approvalDigest` from the reviewed row; a revoke takes neither (§18.7.5) | gains `error: "contribution-trust-review-stale"` on a mismatch |
| `marketplace:update-status` | new event | — | `UpdateStatusView` on change |
| `marketplace:updates-available` | kept | — | `PackageUpdateView` gains `state`, a state of §18.7.5 that needs the user (`updateNeedsUser`: `manual`, `needs-review`, `failed`, `applied-not-running`, `approval-pending`); `manual` only while update notices are on. Built in E (§13.1) |
| every channel | changed | — | failure envelope gains `detail?` (§18.8) |

```ts
type SourceWarning = "unencrypted" | "token-unencrypted" | "internal-network" | "this-computer"
  | "internal-downloads" | "network-folder" | "unencrypted-updates";
interface SourceWarningView { warning: SourceWarning; host: string | null; address: string | null }
// SourceView (shared/git-marketplace.ts:47-71) gains:
//   transport: "git" | "folder"; path: string | null; acknowledged: SourceWarning[];
//   autoUpdate: { effective: boolean; override: "on" | "off" | null; lockedByPolicy: boolean };
// UpdatePlanView gains consentDelta: ConsentDelta (§18.7.3).
// Slice E builds discovery, applyCheckAt, running, historyReset and packages with
// key, displayName, from, to and state (§13.1); F adds waitingSince, autoUpdate,
// and each package's reasons, failure, appliedAt and pendingApproval.
interface UpdateStatusView {
  discovery: { lastAttemptAt: string | null; lastSuccessAt: string | null;
               result: "ok" | "partial" | "offline" | "error" | null; nextAt: string }; // the earlier of the discovery and apply-check due times; the daily apply check discovers even with interval 0
  applyCheckAt: string | null;
  running: boolean;
  historyReset: boolean;               // updates.json was unreadable
  waitingSince: string | null;         // the apply queue's idle wait (§18.7.4)
  autoUpdate: { enabled: boolean; lockedByPolicy: "on" | "off" | null };
  packages: Array<{ key: PackageKeyView; displayName: string; from: string; to: string;
    state: "automatic" | "waiting" | "needs-review" | "manual" | "failed"
         | "applied" | "applied-not-running" | "approval-pending";   // §18.7.5, exactly
    reasons?: string[]; failure?: { code: GitMarketplaceErrorCode; detail?: MarketplaceErrorDetail; attempts: number };
    appliedAt?: string;
    pendingApproval?: { installId: string; consentDelta: ConsentDelta;  // present exactly for an agent plugin's
                        components: ReviewedComponentConsent[] } }>;  // "approval-pending"; an extension's has none (trust list)
}
type ReviewedComponentConsent = ComponentConsent & { approvalDigest: string | null };
```

`pendingApproval` is present exactly for an agent plugin's
`approval-pending` entry. An extension's `approval-pending` entry carries no
payload; its review uses `ave:plugins:contribution-trust:list` and `:set`
(§18.7.5).

`CHANNELS.gitMarketplace` (`app-contract.ts:302-327`) gains `sourcesAcknowledge`,
`sourcesPickFolder`, `sourcesReveal`, `updatesStatus`, `updatesCheck`,
`updatesApplyNow`, `componentsApprove`, `updateStatusChanged`. `GitMarketplaceApi`
(`shared/git-marketplace.ts:414-448`) and its preload surface
(`git-marketplace-api-surface.ts:38-64`) gain `acknowledgeSource`,
`pickFolder`, `revealSource`, `updateStatus`, `checkUpdates`,
`applyUpdatesNow`, `approveComponents`, `onUpdateStatus`. `onMarketplaceUpdatesAvailable`
(`internal-api-surface.ts:589-593`) keeps its name.

**Lock suites**

| Suite | Slice | Change |
|---|---|---|
| `src/data/__tests__/settings-store.test.ts` | E | three new keys and their normalization; `updateCheckIntervalMs` unchanged |
| `src/ipc/__tests__/channel-inventory.test.ts` | C, D1, D2, E, F | C `sources:acknowledge`; D2 `sources:pick-folder`, `sources:reveal`; E `updates:status`, `updates:check`, `marketplace:update-status`; F `updates:apply-now`, `components:approve`. D1 adds no channel and runs the suite to prove it |
| `src/ipc/__tests__/host-renderer-only-channels.test.ts` | C, D2, E, F | each new invoke channel |
| `src/__tests__/preload-shape.test.ts` | C, D2, E, F | the `gitMarketplace` member list |
| `src/ipc/__tests__/domain-exports.test.ts` | none | handlers join the existing `src/ipc/domains/git-marketplace.ts` export; no domain gains a runtime export |

**UI**

- **Updates card** (Settings → Marketplace, beside §15.7's Git runtime card):
  - "Update packages automatically", locked with the policy's text under a
    policy value;
  - "Checks for updates at start-up and once a day · last checked <time> ·
    next <time>";
  - *Check now*, and *Apply now* while updates wait;
  - the updates that need the user, with actions;
  - recent automatic updates with *What changed*.
- **Sources rows**: badges (§18.5); *Allow…*; status with its detail
  (§18.8); an *Automatic updates* select (*Default (On)* / *On* / *Off*).
  Turning it on for an http source shows `unencrypted-updates` first. Folder
  rows per §18.4.8.
- **Installed rows**: the update state (§18.7.5) and an *Automatic updates*
  select.
- **Add dialog**: *Choose folder…*, the confirmation step before any traffic
  or folder access (§18.5), badges in the preview.
- **Update review**: one row per `consentDelta` entry; approve boxes for
  changed or new MCP servers and hooks, extensions included; the one-row
  *Approve update* form when only non-code files changed (§18.7.3); a
  component mode for `approval-pending` agent plugins (§18.7.5).
- **Package sheet**: folder provenance; http and internal Delivery labels.
- **Problems**: `MarketplaceProblem` (§18.8). The mockup gains these states in
  slice G.

### 18.10 Delivery

Every slice merges to `main` independently, with its enforcement, tests and
message keys. None lands an accepted input without its warning and refusal,
and none adds a fallback to keep an intermediate commit green. Each slice
rewrites the owning sections (§7, §12, §13, §14, §15, §17) for what it builds
and removes their pointers to §18.

| Slice | Scope | Depends on | Parallel with | Lock suites |
|---|---|---|---|---|
| **A. Design** | this section; pointers in §1–§17; architecture proposal (decisions D11, D12, §8, §9.1); `extensions-and-plugins.md` §3.2 sentence; Korean mirrors | — | — | none |
| **B. Messages** | error `detail`, envelope, the Sources status path for `detail` (`SyncResult`, `lastSync.detail`, validator, `sourceStatus`), exhaustive `failureText` with reason-less sentences, `MarketplaceProblem`, sentences for every existing code and reason, git failure classification (host key changed, refs listed, unreachable reasons) | A | the Publication plan's P3 | none |
| **C. Target classes, warnings and connection binding (git and downloads)** | `classifyAddress`, `addressPolicy`, the pinned download transport, git http address pinning and the ssh preflight (§18.2.4), gate verdicts, preview confirmation, `acknowledged`, `sources:acknowledge`, catalog rules with `internal-downloads`, credentials over http, policy `requireHttps` and `blockPrivateNetworks`, `PolicySource` and policy refresh (§18.6), refusals #1–4 and #7, Add-dialog confirmation, badges, *Allow…* | B | E | channel-inventory, host-renderer-only-channels, preload-shape |
| **D1. Folder sources: engine and consent** | `source-input.ts` with the four stages, `native/windows-path-kind/` and its CI run, `FolderFs`, `SourceTree` and `FolderTree`, registry `path`, revision, folder read/snapshot/plan capture/install for every kind, `folder` rung and receipt, direct folder, policy `path:`, `allowLocalSources`, `additional[].path`, `SOURCE_LOCAL_UNREADABLE`, `network-folder` warning and its key, refusals #5–6, the `process` refusal on the folder path (§18.4.9) | C (the confirmation flow and `acknowledged`) | E | channel-inventory (no change, asserted) |
| **D2. Folder sources: UI** | `sources:pick-folder`, `sources:reveal`, *Choose folder…*, folder rows and provenance | D1 | E, F | channel-inventory, host-renderer-only-channels, preload-shape |
| **E. Discovery and status** | due rules, hourly due check and resume, attempt/success times, `updates.json`, `UpdateStatusView`, `updates:status` / `updates:check` / `marketplace:update-status`, settings keys, read-only Updates card, pill filter | B | C, D1, D2 | settings-store, channel-inventory, host-renderer-only-channels, preload-shape |
| **F. Automatic apply** | `consentFingerprint`, approval digest, baseline storage and its computation for existing installs, `ConsentDelta` and the review binding, extension component consents, trust store v3 and carry-forward on both paths, both checkpoints, v2 record migration, the approval-carrying precondition, apply queue with `onIdle` and the 30-minute escalation, idle gate at boot, `updates:apply-now`, the agent-plugin MCP lease source and drain, install-addressed payload directories under `.installs/`, outcome classification (consent deferral, failure, post-commit) and the content directory sweep, `approval-pending`, `components:approve` and the approval binding on both surfaces, the cheap non-code review, preconditions and resolution, required-install rules, failure counts, skip on rollback, `autoUpdated` notice, the switches, `unencrypted-updates` | C, D1, E | D2 | channel-inventory, host-renderer-only-channels, preload-shape |
| **G. Docs and mockup** | `web/app/docs/marketplace/*` (ko, en) for folders, warnings and automatic updates; mockup states; remaining pointers folded | D2, F | — | none |

**Order.** A, then B. Then C and E in parallel, each in its own checkout.
Then D1 after C, and D2 after D1; F after D1 and E; G last.

- The second of C and E to merge rebases over textual conflicts in
  `shared/git-marketplace.ts`, `app-contract.ts`, the preload surface and the
  lock snapshots.
- D1 and D2 are each independently mergeable. D1 accepts folder input through
  the existing preview channel, with its consent, policy and refusals
  complete. D2 only adds the dialogs and presentation.
- The Publication plan (`plugin-hostapi-protocol.md` §9.7; P3 and P4 unbuilt; §18.4.9) touches `errors.ts`,
  `labels.ts`, `plugin-ladder.ts`, `direct-package.ts` and
  `plugins/marketplace.ts`:
  - whichever of B and P3 merges second makes `failureText` cover the
    `process` codes that exist then;
  - whichever of D1 and P4 merges second keeps the folder refusal.

**Gates for every slice**:

- `bun run typecheck`;
- targeted Vitest directories (`bun run test:vitest -- run <dirs>`);
- the lock suites named above;
- `bun run check:i18n-catalog` when keys change;
- the naming gate with GNU grep;
- the pre-push hook's full `bun run test` and `bun run build`, once, at
  publication.

The E2E flows named below run in `test/e2e/ui/`.

**Revert-to-fail targets** (each test fails when its rule is reverted):

- **B**:
  - `labels.test.ts`: every code and reason maps to a catalog key, never
    `CODE · message` (revert: restore `default`). A code without a `detail`
    renders its reason-less sentence.
  - A bridge test in `src/shared/__tests__/`: a known `detail` survives
    `parseGitMarketplaceResult`; an unknown one is dropped, with code and
    message kept.
  - `sync.test.ts` and `views.test.ts`: a background sync failing with
    `SOURCE_UNREACHABLE` reason `dns` (an existing code) persists the detail
    with its host. After
    the registry is reopened from disk, `sources:list` carries it, and
    `SourcesAndAdd.test.tsx` shows the localized sentence (revert: persist
    only the code).
  - `run-git.test.ts`: a changed host key is `changed`, not `unknown`; a
    missing ref carries the refs `ls-remote` listed.
- **C**:
  - `network-gate.test.ts`:
    - an entered `10.0.0.5` is a warn verdict, not a throw;
    - `198.18.0.1` is internal;
    - `169.254.169.254`, `fd00:ec2::254` and `100.100.100.200` are refused
      even for a listed host;
    - a catalog download to `127.0.0.1` on another port is refused, and one
      to the loopback source's own port is accepted;
    - a catalog download to another internal host fails for a source
      holding only `internal-network` and passes with `internal-downloads`
      (revert: imply it);
    - `requireHttps` blocks an acknowledged http source;
    - `blockPrivateNetworks` blocks an acknowledged internal source.
  - `pinned-fetch.test.ts` and `run-git.test.ts`: §18.2.4's rebinding
    cases; `ssh-preflight.test.ts`: the ssh preflight and its residual.
  - `service.test.ts`:
    - a preview that needs a warning answers `confirm`, and the git runner
      and resolver record zero calls (revert: classify after the fetch);
    - *Add* stores exactly the carried confirmations;
    - a sync whose host became internal fails with
      `SOURCE_CONFIRMATION_REQUIRED`;
    - rewriting the policy file while the service runs blocks the next
      preview and expires an existing plan with `policy-changed`; an invalid
      file then a fixed file goes official-only then back (revert: load
      once).
  - `run-git.test.ts`:
    - `GIT_ALLOW_PROTOCOL` holds `http` only for an acknowledged or listed
      source;
    - an http remote without `token-unencrypted` carries
      `-c credential.helper=` and gets no askpass ticket, **for a managed
      http source with a stored token too** (revert: let a listing imply
      it).
  - `source-url.test.ts`: `ext::sh`, `fd::3` and `hg::https://…` are
    `helper-transport`; `https://u:p@h/x` is `credentials-in-url`; `git@h:x`
    stays accepted.
  - `policy.test.ts`: the new keys parse exactly; an unknown key still
    invalidates the section.
  - `ave-protocol.test.ts`: a deep link with a folder path is refused.
  - E2E (`git-marketplace-lifecycle.spec.ts`): add an http loopback source,
    confirm, see the badge.
- **D1**:
  - `source-input.test.ts`, run with `path.posix` and `path.win32`:
    - `~`, drive, UNC, `//server/share`, `\\?\`, `\\?\UNC\` and `file:`
      normalize;
    - `./x`, `C:foo`, `\\.\x`, `\\?\Volume{…}` and a drive path on POSIX
      are refused;
    - `a/b` stays the GitHub shorthand.
  - `folder-consent.test.ts`, with the recording `FolderFs` fake:
    - for `\\server\share\m`, and for a drive whose `queryDosDevice` answers
      `\Device\Mup\…`, preview answers `confirm` with **zero** recorded calls
      other than `queryDosDevice` (revert: resolve first);
    - under `allowLocalSources: false`, the same input is blocked with zero
      recorded calls;
    - after `acknowledge`, the walk records `lstat` calls and never a
      `realpath`;
    - root resolution: `/tmp/market` with the ancestor link
      `/tmp → private/tmp` resolves to `/private/tmp/market`; a root that is
      itself a link (`~/m → /opt/m`) resolves to `/opt/m`; an ancestor link
      whose text is `\\server\share` is refused as `link-to-network` with no
      call on the server path (revert: apply package containment to the
      root).
  - `folder-tree.test.ts`, with the recording fake:
    - an inside link installs as a regular file;
    - an outside link is `link-outside-folder`, with no call on its target;
    - a chain `root/a → root/b → \\attacker\share` and a junction
      `root/j → \\attacker\share` in an ancestor of a package are both
      `link-to-network`, with no recorded call on any `\\attacker` path
      (revert: `realpath` inside links);
    - an `fstat` identity mismatch is `changed-during-read`;
    - **ancestor swap**: the fake replaces `root/d` with a link to an
      outside directory after `root/d` is enumerated and before
      `root/d/file` is opened, and keeps it replaced. The re-`lstat` of the
      parent chain reports `changed-during-read`, and no byte of the outside
      file reaches the package (revert: drop the parent-chain recheck). The
      same swap restored before the recheck is recorded as the documented
      residual: the test asserts the read completes and names the case;
    - `.git/` and `.DS_Store` are skipped;
    - NFD digests as NFC, and NFC-equal names are refused.
  - `folder-identity.test.ts`, with a fake case-sensitive volume holding
    both `/Approved/Tools` and `/approved/tools`:
    - two sources;
    - the `allow` rule `path:/Approved/Tools` does not admit
      `/approved/tools`;
    - `block` `path:/tmp/*` blocks `/TMP/x`.

    With a fake case-insensitive volume, the two spellings are one source
    through equal `dev`/`ino` (revert: platform case folding). Nesting is
    refused.
  - `folder-sync.test.ts`: a background read failing
    `SOURCE_LOCAL_UNREADABLE` reason `permission` persists that detail through
    slice B's path and renders after a reload (the folder case moved from B).
    Editing a `SKILL.md` changes the revision
    (revert: drop package digests), and the git runner records zero calls
    for a folder source.
  - `folder-plan.test.ts`: a file changed between plan and execute installs
    the planned bytes (revert: read at execute).
  - `plugin-ladder.test.ts`:
    - a folder with `src/` installs and lists `src/` as not installed, while
      a git tree with `src/` still fails the rung;
    - a folder plugin with a declared release never calls `fetchImpl`;
    - a `process` manifest from a folder is refused with the code `main`
      has at merge time.

    As built, the git case is in `plugin-ladder.test.ts` and the three
    folder cases run through the service in `folder-plan.test.ts` (§17).
  - `policy.test.ts`: `allowLocalSources: false` blocks a folder; an `allow`
    list without `path:` blocks a folder; `path:/opt/a/*` admits `/opt/a/b`.
  - Windows CI: `native/windows-path-kind/` maps `C:` to a local volume and
    a `subst` drive to its target, and fails closed on an unknown drive.
- **D2**:
  - `git-marketplace.test.ts` (IPC domain): `reveal` refuses a git source
    and an unknown id (revert: accept any id); `pick-folder` returns `null`
    on cancel; a pick previews and adds the folder main chose, never the
    sibling its masked display names (revert: keep the display as the
    path), and a forged, replaced, used or expired pick is
    `folder-pick-unknown` (revert: accept any held pick).
  - `SourcesAndAdd.test.tsx`: the folder row, *Choose folder…*, the
    `network-folder` warning.
  - E2E: add a folder marketplace, install a skill, edit it, *Refresh*, and
    see the package row offer the update. Applying it automatically is F's
    E2E.
- **E**:
  - `background.test.ts`:
    - an offline discovery is retried at the next hourly due check, not an
      interval later (revert: due from the last completion);
    - a successful discovery at hour 0 and an offline *Check now* at hour 1
      give a retry at hour 2 (revert: gate the retry on `lastSuccessAt`);
    - with the default interval, a successful discovery is not repeated for
      6 hours;
    - the apply check is due 24 hours after the last one and at boot;
    - **exact boundary**: with `updateCheckIntervalMs` at 48 hours, a
      discovery and an apply check at hour 0, and a release published at
      hour 0 plus one minute, the apply check at hour 24 (the last
      discovery exactly 24 hours old) runs a discovery first and classifies
      the release (revert: classify when the last discovery is not older
      than 24 hours);
    - **independently phased**: with the default interval, discoveries at
      hours 0, 6, 12, 18 and 24, and the last apply check at hour 3, the
      apply check at hour 27 starts its own discovery although one
      succeeded 3 hours earlier, and classifies a release published at
      hour 25 (revert: reuse a recent discovery);
    - an apply check that becomes due while a discovery runs joins it and
      starts no second one; with that discovery `partial`, the reached
      sources' updates are classified and `applyCheckAt` is not written;
    - a clock jump of 30 hours followed by `resume` runs a discovery
      (revert: plain `setInterval`);
    - an all-offline discovery publishes `offline`;
    - `updates:check` resolves when its discovery and apply check end, while
      the apply queue still waits (revert: join the apply). E builds no
      apply queue: E's test fails when `updates:check` answers before its
      apply check ends, and the queue half lands with F's `apply.test.ts`;
    - an unreadable `updates.json` sets `historyReset` and runs a
      discovery.
  - `settings-store.test.ts`: the new keys normalize, and invalid entries
    are dropped.
  - `PluginUpdatesPill.test.tsx`: only states that need the user are
    counted.
- **F**:
  - `consent.test.ts`:
    - one row per fingerprint field of every kind; changing that field alone
      gives `needs-review` (revert: remove the field, and its row fails);
    - an `unknown` baseline field gives `needs-review`;
    - the baseline is read from the receipt, ledger or MCP record, and a
      catalog whose copy of the installed version differs does not change it
      (revert: read the catalog).
  - `approval-digest.test.ts`:
    - changing `dist/server.js`, or a `dist/lib/util.js` it loads, while
      `.mcp.json` stays byte-identical changes the digest; the update is
      `needs-review`, and no approval carries (revert: digest the
      declaration only);
    - **indirect load**: an approved `server.js` evaluates
      `skills/helper/assets/rules.txt`; changing only that file changes the
      digest and gives `needs-review` (revert: exclude non-executable
      files);
    - **a complete versioned release** — `plugin.json` `version` bumped and
      one `SKILL.md` edited — in a package **without** a local executable
      component applies automatically; the same release in a package
      **with** a stdio MCP server gives `needs-review` with the one-row
      "Only these non-code files changed" delta, and *Approve update*
      approves every changed component in one call (revert: hash
      `version`, or drop the cheap form);
    - a change to any other `plugin.json` field changes the digest and
      lists `plugin.json` under `changedFiles.code`;
    - `npx foo` and `image:latest` give `null` and never carry;
    - `npx foo@1.2.3` and an `@sha256:` image carry while unchanged.
  - `plugin-contribution-trust.test.ts`:
    - a real version-2 trust file from 0.12 loads. A record whose
      generation is active and whose fingerprint matches the installed
      declaration gets an `approvalDigest` from the installed bytes and
      carries; any other record gets `null`. The next write is version 3;
    - a version-3 file round-trips;
    - a provisional carried approval is revoked when publication throws, and
      the store equals its state before the attempt;
    - a source record revoked between prepare and publish is not carried,
      and the automatic update becomes `needs-review`.
  - `eligibility.test.ts`, the approval invariant: an update whose
    fingerprint is equal but where an approved component (a remote MCP
    server with a `null` migrated digest) would not carry is `needs-review`,
    never automatic. After any automatic update in the suite, every
    component approved before it is approved after it (revert: drop the
    precondition).
  - `agent-plugin-mcp-runtime.test.ts`, through the real `McpManager`:
    - `withBundledLease` for an `agent-plugin/` owner acquires from the
      runtime's lease source, not from `PluginBundleLifecycle` (revert: no
      prefix routing);
    - a call through a **registered tool**, the `execute` that
      `bindBundledTool` returned, for an `agent-plugin/` owner acquires from
      the same lease source; a tool object bound to an activation that has
      since retired, held from before publication, throws on `execute` and
      runs nothing (revert: leave `bindBundledTool` on
      `generationAccess`);
    - an MCP call in flight on the old activation while a **concurrent
      folder refresh of the same version** installs completes with its
      result; the old payload directory still exists while it runs; the
      predecessor disconnects and its directory is removed only after the
      drain (revert: disconnect at once, or install over the version
      directory);
    - a call started after publication lands on the new activation, and
      `acquireExact` on the retired one throws.
  - `agent-plugin-mcp-runtime.test.ts` and `agent-plugin-hook-runtime.test.ts`:
    an unchanged approval digest carries; a changed one does not (revert:
    drop carry-forward). The extension design's "re-ask on update" test is
    rewritten to this rule.
  - `store.test.ts`:
    - two installs of one version write two `.installs/<installId>/`
      directories, and none is under `<version>/`;
    - an entry without `payloadDir` still resolves to `<version>/`;
    - **legacy same-version refresh**: a legacy install at `<version>/` is
      refreshed at the same version, its predecessor retires, and the app
      reboots (boot sweep included); the replacement's files stay readable
      and the legacy `<version>/` is gone (revert: write the replacement
      under `<version>/`);
    - the boot sweep removes a `.installs/<installId>/` no ledger entry
      names.
  - `apply.test.ts`:
    - while a **session mutation with no turn** holds the coordinator busy,
      the installer is not called, and it is called when the mutation ends
      (revert: wait on `onTurnSettled` only);
    - at boot, with a turn already running, the queue waits (revert: exempt
      boot);
    - after 30 minutes of waiting, the notice and `updates:apply-now`
      appear, and without *Apply now* the queue keeps waiting;
    - a failure before commit leaves the previous version, with state
      `failed` and one attempt;
    - `UpdateNeedsReviewError` at checkpoint two three passes in a row
      leaves `needs-review` with zero attempts (revert: count it as a
      failure);
    - a `CommittedPluginGenerationPublicationError` with `outcome.state:
      "inactive"` records the new version as installed and
      `applied-not-running`, with `"active"` gives `applied`, and counts no
      attempt (revert: treat it as `failed`);
    - every state the pass writes is a member of the view's union (the test
      enumerates both);
    - the third failure stops automatic attempts;
    - a staged `plugin.json` with a new bundled hook throws
      `UpdateNeedsReviewError` before `activatePreparedArtifact` (revert:
      skip the second checkpoint);
    - a manual review of an update that adds a catalog-visible capability
      and a bundled hook stages before approval and shows both (revert:
      stage only when checkpoint one found nothing);
    - a reviewed plan executes the staged bytes without a second download.
  - `eligibility.test.ts`:
    - disabled, hidden source, downgrade, switch, rewrite, skipped, and http
      without `unencrypted-updates` are never automatic;
    - policy `off` beats a package `on`, and policy `on` beats a package
      `off`;
    - a manual rollback records the skip;
    - for a required install, a changed authority field applies with the
      switch off; a changed MCP digest applies with that server unapproved
      and the package `approval-pending`, while an unchanged one stays
      approved; a revoked version and an incompatible version are not
      applied (revert: the switches gate required installs).
  - `git-marketplace.test.ts` (IPC domain): `components:approve` approves the
    named components of an `approval-pending` agent plugin through the
    runtimes' `activate`, refuses another package's key, and clears the
    state.
  - **Replacement between review and submit**, on both surfaces. The review
    reads generation A; a required update installs generation B, which
    changes only `skills/helper/assets/rules.txt`, so the server's
    component digest is unchanged; then the user submits A's approval:
    - `components:approve` with A's `installId` fails `PLAN_EXPIRED`
      reason `package-changed`, and no component of B is approved (revert:
      drop the `installId` and digest check);
    - `contribution-trust:set` with A's `generationId` and `approvalDigest`
      returns `contribution-trust-review-stale`, and B's record is not
      approved (revert: approve the active generation);
    - with a `null`-digest component, the same replacement is rejected by
      the generation check alone;
    - **an unchanged generation's approval succeeds**: with no replacement,
      `components:approve` with the current `installId` approves, and
      `contribution-trust:set` with the row's `generationId` and
      `approvalDigest` approves, also when the extension was activated
      again between the list and the submit, which gives a new coordinator
      generation id for the same artifact (revert: compare the coordinator's
      `generation.generationId`).
  - E2E, `test/e2e/ui/git-marketplace-auto-update.spec.ts`, with its own
    fixture:
    - the app launches with an isolated `AVE_HOME` and
      `AVE_E2E_MARKETPLACE_SCHEDULER=1`. `startBackground`
      (`git-marketplace.ts:620-625`) honours the variable only when
      `isE2eTestRuntime()` is true, and starts the real scheduler instead of
      returning;
    - a loopback http git fixture; the spec turns automatic updates on for
      that source through the UI and confirms `unencrypted-updates`;
    - the spec commits a new version to the fixture and presses *Check now*;
      it then asserts through IPC that `updates:status` shows the package
      `applied` and that the installed list holds the new version, and sees
      "Updated automatically";
    - a version that adds a capability shows *Review* and stays at the old
      version.

    No status event is mocked.
- **G**: the site build, the docs gates, the naming gate.

### 18.11 Decisions

| # | Decision | Reason |
|---|---|---|
| 1 | Four outcomes; one table for entered targets, one for catalog-supplied (§18.2) | The owner separated the user's targets from a third party's; one vocabulary keeps the UI tones consistent |
| 2 | Address classes computed once in `network-guard.ts`; `198.18.0.0/15` internal; unspecified addresses are this computer; metadata addresses carved out of ULA and CGNAT (§18.2.1) | One list of ranges; fake-IP proxy tools would otherwise make every source "unroutable"; `0.0.0.0` reaches loopback; metadata is refused wherever it lives |
| 3 | Confirmation before any traffic or folder access, once, carried from preview to add (§18.5) | "After one confirmation"; a token, or a Windows sign-in, must not leave before consent |
| 4 | Confirmations stored per class; asked again when a target's class grows (§18.5) | Addresses change inside a class; a new class is a new risk |
| 5 | Catalog-supplied http downloads accepted with a Delivery label (§18.2.3) | The sha256 pin, read over the source's own transport, fixes the bytes; transport integrity adds nothing the pin lacks |
| 6 | Catalog-supplied internal downloads on another host need `internal-downloads`, never implied by `internal-network`; the warning names the attack (§18.2.3, §18.8) | A catalog that can name internal hosts can send state-changing requests into the user's network, and a later digest failure cannot undo a request; confirming one server does not inform the user of that |
| 7 | Catalog-supplied this-computer targets on another host or port refused (§18.3 #4) | Named attack on local services |
| 8 | No git command runs against a folder; a checkout is read as its working tree (§18.4.3) | git reads the checkout's configuration, which can run programs |
| 9 | Folders read in place; the plan captures the bytes (§18.4.2) | What the user reviewed is what installs |
| 10 | A folder's pin is a content revision covering every package digest; no history rule; only the folder's version installs (§18.4.3) | §7.3 needs a pin; an edit to a skill must count; a folder has no history and no other version |
| 11 | No source type for a lone `marketplace.json` URL; such an address gets a message (§18.3) | Ave reads descriptors, content, icons and revocations from the tree, which a lone index cannot carry |
| 12 | `git://` unsupported, with a message (§18.3) | The PAC proxy cannot route it; the same repository is served over https or ssh |
| 13 | Beneath the canonical root, links are followed by text, component by component; links outside or to a network location (by their text or the target it resolves to) are refused without touching the target; while the root itself is resolved, local ancestor and root links are followed after the same network check; every path the walk and the reader touch is classified first, and one on another computer without `network-folder` answers `confirm`; persistent swaps are detected by re-checking the directory chain; OS metadata skipped, through links and aliases too; hard links read as regular files; names NFC (§18.4.1, §18.4.5) | Following by text is the only way to refuse a UNC target before contacting it; classifying the text alone misses relative targets and recovered spellings, so the call itself is fenced; containment protects the package, not the user's own path to the folder; a hard link reaches no directory, volume or server; a swap-and-restore race by a concurrent local writer is a stated residual, since Node offers no portable handle-anchored traversal |
| 14 | A folder source never downloads: one `folder` rung; extra top-level entries ignored and listed (§18.4.2) | A folder's declared pin lives in files anyone who can write the folder changes without trace, so it is not commit provenance; folder receipts stay ineligible for `process` admission; a developer's checkout always holds sources |
| 15 | Folder identity is the canonical path or equal `dev`/`ino`; no platform case folding; `allow` matches with exact case, `block` without (§18.4.4, §18.6) | Case sensitivity is per volume, not per platform; when it is unknown, the conservative result admits less and blocks more |
| 16 | Discovery (sync and revocations) every 6 hours; the update apply check at boot and once a day, always running or joining a discovery first; one scheduler (§18.7.1) | The owner's cadence is for updates; revocations ride the same fetch and 0.12 already delivers them within 6 hours, so a 24-hour discovery would keep a revoked package running four times as long; a daily check must not wait on a longer interval |
| 17 | Two due branches: after a failed attempt, retry hourly from `lastAttemptAt`; after success, wait the interval from `lastSuccessAt`; discovery never waits for the apply queue (§18.7.1) | A success-based rule would skip retries after an offline manual check, and an idle wait would delay revocations |
| 18 | Automatic updates default on for every origin, folders included; http sources off until `unencrypted-updates` (§18.7.2) | The owner's instruction; the consent fingerprint holds back every update that changes what runs or what it may reach, so a broad default applies only text and data; the http attack is named |
| 19 | Preconditions, then policy, package, source, global, default (§18.7.2) | Each precondition is a user or source decision no switch overrides; policy outranks the user |
| 20 | Any consent-fingerprint difference, a narrowing included, any `unknown` baseline field, and any previously approved component that would not keep its approval, needs review (§18.7.2, §18.7.3) | The owner's rule taken literally; equality is deterministic and testable; an automatic update must never silently disable a component the user approved |
| 21 | Every `mcp` package update needs review (§18.7.3) | An MCP server declares no authority; its command is its authority, and its version is in the command |
| 22 | Packages with no local executable component (stdio MCP, command hook, `process` entry) apply changed text and data automatically (§18.7.3) | `extensions-and-plugins.md` decision 18 activates them without consent; a routine template creates nothing; nothing local runs that could read the changed files |
| 23 | The approval digest covers declaration, anchored files and the **whole** package tree, normalizing only `plugin.json` `version`; an undeterminable closure is `null`; carry-forward is provisional until publication revalidates it; a code-free change gets a one-action review (§18.7.3) | No runtime boundary keeps an unchanged server from evaluating another package file, so exclusions by extension or execute bit are unsafe; the version bump is release bookkeeping that runs nothing; review stays cheap instead of being skipped |
| 24 | Two checkpoints: catalog, then staged bytes before activation; a manual review stages and installs exactly those bytes (§18.7.3) | The index cannot show an extension's bundled servers and hooks; approval must cover the bytes that install |
| 25 | Updates wait for `onIdle` across all four busy conditions, at boot too; after 30 minutes an escalation offers *Apply now*; agent-plugin MCP gets its own lease source and drain, acquired by one helper for registered tools and `withBundledLease`, and payload directories are install-addressed under `.installs/`, disjoint from legacy `<version>/` (§18.7.4) | "Without interrupting a running turn"; startup order is not a barrier; the agent-plugin path had no lease owner, a same-version refresh moved live files, and a nested replacement would be deleted with its legacy predecessor |
| 26 | Required installs update at every apply check through the apply queue; the policy approves authority, not MCP servers or hooks; an unapproved component is `approval-pending` with a notice and *Review* (§18.7.2, §18.7.5) | §10.2: the policy stands for authority consent; an unapproved projection is never published (`mcp-manager.ts:393`), so the pending approval must be visible and actionable |
| 27 | A manual rollback records the newer version as skipped (§18.7.5) | Otherwise the next pass undoes the rollback |
| 28 | Failures before commit show and retry; stop after three for one version; consent deferrals and post-commit failures are not attempts; every outcome maps to a state of the view (§18.7.4, §18.7.5) | "Visible status, not silent"; a deferral awaiting consent must not exhaust retries; after a durable commit there is nothing to install again |
| 29 | Error envelope and persisted source status carry `detail`; `failureText` exhaustive with reason-less sentences; three tones (§18.8) | Today every unmapped code prints the code and an English message (`labels.ts:116`), and background failures lose their reason |
| 30 | The studio's *Install from file* stays a one-time source-less install; *Install from Git URL or folder…* is the tracked install (§18.4.7) | A shipped flow keeps its meaning; a zip has nowhere to update from; the tracked path is the one that updates |
| 31 | Policy gains `requireHttps`, `blockPrivateNetworks`, `allowLocalSources`, `autoUpdate`, `path:` patterns, `additional[].path`; an allow list without `path:` blocks folders; the policy is re-read per operation (§18.6) | Administrators keep the strict behaviour; fail closed as §12; a policy change must not wait for a restart |
| 32 | Over http, askpass and credential helpers work only with `token-unencrypted`, which no policy listing implies (§18.2.2) | A password must not cross the network in the clear unannounced; a transport listing is not a credential grant |
| 33 | Deep links never carry a folder (§18.3 #7) | A web page must not choose a folder, or a UNC server, on this computer |
| 34 | Network folders need `network-folder`, classified lexically and through `QueryDosDeviceW` before any filesystem call (§18.4.1) | Reading one signs in to that server with the user's Windows account, so even a `stat` must wait for consent |
| 35 | The `process` admission rule is not relaxed; folder receipts are categorically ineligible; the codes follow the Publication plan as it merges (§18.4.9) | It belongs to `plugin-hostapi-protocol.md` |
| 36 | The switches live in settings; the http precondition is a source confirmation only main records (§18.9) | Main must enforce the http precondition; a settings write cannot |
| 37 | Eight slices; B first; C and E in parallel; D1 after C; F after D1 and E (§18.10) | Each is coherent at its boundary; the first folder-accepting slice carries its own consent; F needs the folder contracts |
| 38 | Address-dependent refusals and blocks bound to the connection on the transports Ave owns: pinned download transport for every supported PAC kind and `http.curloptResolve` for git over http/https. For SSH a preflight check only on the `ssh -G` host name, with no `HostName`, `HostKeyAlias` or `CheckHostIP` option. A PAC proxy, local or remote, is trusted beyond its checked socket; an ssh `ProxyCommand` or `ProxyJump` is run by ssh and trusted like any user-configured program (§18.2.4) | A separate earlier lookup lets DNS rebinding pass a hard refusal; pinning ssh changes the user's host-key and certificate identity, and host-key verification is the SSH trust anchor; Ave cannot see where a proxy connects, so the boundary is stated rather than implied |
| 39 | A version-2 approval whose generation is active and whose fingerprint matches the installed declaration gets its approval digest from the installed bytes; any other gets `null` and its package's first update needs review (§18.7.3) | Those are the bytes the user approved and is running, already bound by the v2 identity; anything else cannot be shown equal |
| 40 | An approval of an installed component carries the reviewed generation (an agent plugin's `installId`, or an extension's artifact generation id, never the activation-bound coordinator id) and each component's `approvalDigest`, re-validated under install and publication serialization; a mismatch approves nothing (§18.7.5) | A required update can replace the generation while the user reviews it, and a component digest does not cover the whole tree |
