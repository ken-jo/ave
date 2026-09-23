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
| **Source** | A registered git repository the app reads packages from. Kinds: `official`, `custom`, `direct`. |
| **Marketplace repository** | A source whose root has `marketplace.json`, or that follows the conventional layout (§3.3). |
| **Package** | One installable unit: `plugin`, `mcp`, `skill`, `agent`, `theme`, `font`, `language`, `provider`, `messaging-connection`. |
| **Descriptor** | `ave-package.json` in a package directory: kind, name, version, compatibility, payload. |
| **Pin** | The commit SHA a source is currently read at. |
| **Snapshot** | The parsed, validated catalog of one source at one pin. Immutable. |
| **Install plan** | What the resolver will do for one package version: artifact rungs, files, launcher, and required consent. |
| **Rung** | One step of the plugin artifact ladder: `release`, `archive`, `tree`. |

## 2. Client state on disk

```
~/.ave/
  installation-id                     # random UUID, local only (rollout bucketing)
  marketplaces/
    sources.json                      # source registry (§2.1)
    <sourceId>/
      repo.git/                       # bare partial clone
      snapshots/<commit>.json         # validated snapshot (§2.2)
      sync.json                       # last sync outcome
  packages/
    <kind>/<name>/<version>/          # installed content packages
    ledger.json                       # installed content packages + origin
  plugins/                            # unchanged plugin install root
  runtime/git/<version>/              # managed git copy (§9)
```

### 2.1 `sources.json`

```ts
interface SourcesFile {
  version: 1;
  sources: SourceEntry[];
}

interface SourceEntry {
  id: string;                 // ^[a-z0-9][a-z0-9-]{1,62}$, reserved names rejected
  origin: "official" | "custom" | "direct";
  url: string;                // https://…, ssh://…, git@host:path; http:// only for policy-listed hosts (§12)
  ref?: string;               // branch or tag; default = remote HEAD
  subdir?: string;            // direct sources only: package path inside the repo
  pinnedCommit: string | null;   // 40-hex; null until the first successful sync
  enabled: boolean;
  auth: { kind: "none" } | { kind: "token"; host: string } | { kind: "ssh" };
  addedAt: string;            // ISO-8601
  label?: string;             // user-visible override of displayName
  acceptedRewriteAt?: string; // custom/direct: last explicit history-rewrite acceptance
}
```

- The official entries are not stored here. They come from the build constant
  `OFFICIAL_MARKETPLACE` (`id: "ave"`, primary URL, optional mirror URLs) and
  their pin is stored in `marketplaces/ave/sync.json`. The user can disable
  the official source only when managed policy allows it.
- Tokens are stored in the existing encrypted secret store under
  `marketplace.gitToken.<host>`; `sources.json` never holds a secret.

### 2.2 Snapshot

```ts
interface SourceSnapshot {
  sourceId: string;
  commit: string;
  fetchedAt: string;
  marketplace: { name: string; displayName: string; description?: string; owner?: { name: string; url?: string } };
  packages: CatalogPackage[];          // §4, after validation and normalization
  policy?: { revocations: Revocation[]; grants: Grant[] }; // official only (§10)
  diagnostics: SnapshotDiagnostic[];   // per-package rejections, shown in the Sources view
}
```

A package that fails validation is dropped from the snapshot with a
diagnostic; the rest of the source stays usable. An invalid `marketplace.json`
(unparseable, wrong `schemaVersion`, duplicate keys) rejects the whole
candidate commit and keeps the previous pin.

### 2.3 Registry origin

`PluginRegistryEntry` gains:

```ts
origin?: {
  sourceId: string;
  sourceOrigin: "official" | "custom" | "direct";
  commit: string;
  packagePath: string;
  version: string;
  rung: "release" | "archive" | "tree";
  artifactSha256: string;      // sha256 of the zip (release/archive) or tree digest (tree, §6.4)
  installedAt: string;
};
```

`installSource` keeps its existing values. Content packages record the same
origin in `packages/ledger.json`.

## 3. Marketplace repository layout

### 3.1 Official monorepo

```
marketplace.json                 # index (generated by CI, committed)
plugins/<name>/ave-package.json # + optional built tree (plugin.json, dist/)
mcp/<name>/ave-package.json     # + optional server.json
skills/<name>/                   # ave-package.json, SKILL.md, resources
agents/<name>/                   # ave-package.json, AGENTS.md
themes/<name>/                   # ave-package.json, theme.json
fonts/<name>/                    # ave-package.json, font.json, files/
languages/<locale>/              # ave-package.json, language.json, messages.json
providers/<name>/                # ave-package.json, provider.json
messaging/<name>/                # ave-package.json, connection.json
policy/revocations.json
policy/grants.json
.github/CODEOWNERS
.github/workflows/               # validate, index, release-pin
```

### 3.2 Custom marketplace

Same layout; `policy/` is ignored for custom sources. `marketplace.json` may
be hand-written and may list only `path` for each package (§4.2).

### 3.3 Conventional layout without `marketplace.json`

If the root has no `marketplace.json`, the client scans these directories at
the pinned commit, one level deep, for `ave-package.json`:
`plugins/ mcp/ skills/ agents/ themes/ fonts/ languages/ providers/ messaging/`.
The marketplace name defaults to the source id. A repository with neither an
index nor any descriptor in those directories is not a marketplace; the add
dialog offers the direct-install flow instead.

## 4. `marketplace.json` (index)

### 4.1 Schema

```ts
interface MarketplaceIndex {
  $schema?: string;
  schemaVersion: 1;
  name: string;                     // must equal the source id for official; informative for custom
  displayName: string;
  description?: string;
  owner?: { name: string; url?: string };
  packages: IndexPackage[];
}

interface IndexPackage {
  kind: PackageKind;
  name: string;                     // unique per kind within this index
  path: string;                     // repo-relative, "./"-free, no "..", "/" separators
  displayName?: string;
  description?: string;
  keywords?: string[];
  icon?: string;                    // repo-relative image path
  latest?: string;                  // semver; must be in versions[] when present
  versions?: IndexVersion[];        // newest first; absent = read the descriptor at the pin
}

interface IndexVersion {
  version: string;                  // semver 2.0.0
  commit: string;                   // 40-hex; the commit whose descriptor declares this version
  engines: { ave: string };        // copy of the descriptor's range
  artifact?: PluginArtifactPins;    // plugin kind only (§5.2)
  rollout?: { percent: number };    // 1..100; absent = 100
  yanked?: { reason: string; at: string };
  publishedAt: string;
}
```

### 4.2 Rules

- `(kind, name)` is unique; `(kind, name, version)` maps to exactly one
  commit. CI rejects re-publishing an existing version at a new commit.
- Versions strictly increase per package (existing plugin rule, now for all
  kinds).
- When `versions` is absent, the client reads `ave-package.json` at
  `path` at the pinned commit and treats it as the single available version.
- Unknown root keys are rejected in `schemaVersion: 1`.

### 4.3 Official index generation

CI regenerates `marketplace.json` from the previous index plus the descriptors
at the merge commit and fails the PR if the committed file differs. A merge
to `main` is the publish (D8). The release-pin workflow (§6.3) is the only
automation that edits artifact pins.

## 5. Package descriptor `ave-package.json`

### 5.1 Common fields

```ts
interface PackageDescriptor {
  $schema?: string;
  schemaVersion: 1;
  kind: PackageKind;
  name: string;                     // plugin: equals plugin.json `name`
  version: string;                  // required, semver
  engines: { ave: string };        // required, semver range over the app version
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

`engines.ave` is evaluated against the running app's `X.Y.Z`. Pre-release app
builds match a range only if the range itself names a pre-release of the same
`X.Y.Z`; a plain range such as `>=0.11.0` never admits `0.12.0-beta.1`.

### 5.2 Payload by kind

| Kind | Payload | Files the package directory may contain |
|---|---|---|
| `plugin` | `{ artifact: PluginArtifactPins }` | `ave-package.json`; for the tree rung also `plugin.json`, `dist/**`, `assets/**` |
| `mcp` | `{ server: McpServerSpec } \| { serverJson: "server.json", select?: { package?: number; remote?: number } }` | `ave-package.json`, `server.json`, optional `server/**` for a package-local stdio command |
| `skill` | `{ entry: "SKILL.md" }` | `SKILL.md`, `references/**`, `assets/**` (text and images only) |
| `agent` | `{ entry: "AGENTS.md" }` | `AGENTS.md` |
| `theme` | `{ entry: "theme.json" }` | `theme.json`, optional preview image |
| `font` | `{ entry: "font.json" }` | `font.json`, `files/*.woff2\|woff\|ttf\|otf`, `LICENSE` |
| `language` | `{ locale: string; entry: "language.json"; messages: "messages.json" }` | those two JSON files |
| `provider` | `{ entry: "provider.json" }` | `provider.json` (today's `MarketplaceProviderPackageAsset` minus `type`) |
| `messaging-connection` | `{ entry: "connection.json" }` | `connection.json` (today's messaging asset minus `type`) |

```ts
interface PluginArtifactPins {
  release?: {
    repo?: string;      // "owner/name" on the same host; default = the source repo
    tag?: string;       // default "v{version}" (single-package repo) or "{name}-v{version}" (monorepo)
    asset?: string;     // default "{name}-{version}.zip"
    url?: string;       // explicit URL for non-GitHub release hosts
    sha256?: string;    // required for the rung to be used (§6.2)
  };
  archive?: { url: string; sha256: string };
  tree?: string;        // repo-relative directory holding plugin.json + dist/; default = package path
}

type McpServerSpec =
  | { transport: "stdio"; command: "npx" | "uvx" | "docker" | string; args?: string[];
      env?: Record<string, string>; userConfig?: UserConfigField[] }
  | { transport: "http"; url: string; headers?: HeaderField[] };
```

A `stdio` command that is not `npx`, `uvx` or `docker` must be a path relative
to the package directory (`server/…`); absolute paths and `..` are rejected.

### 5.3 Plugin manifest addition

The host plugin schema (`schemas/plugin-manifest.schema.json`) gains
`extensions["ai.agent-connector.ave"].engines`:

```jsonc
"engines": { "ave": ">=0.11.0 <0.13.0" }
```

It is required for any plugin installed from a git source and must equal the
descriptor's `engines`. The descriptor is what the catalog reads without
downloading bytes; `plugin.json` is what travels with the bytes. The install
check compares them the same way `assertInstalledManifestMatchesCatalog`
compares capabilities today.

### 5.4 Content validation limits

| Kind | Max total | Max files | Allowed extensions |
|---|---|---|---|
| skill | 2 MB | 64 | `.md .txt .json .yaml .yml .png .jpg .svg` |
| agent | 256 KB | 1 | `.md` |
| theme | 256 KB | 4 | `.json .png .jpg` |
| font | 20 MB | 32 | `.json .woff2 .woff .ttf .otf` + `LICENSE` |
| language | 4 MB | 2 | `.json` |
| provider, messaging-connection | 64 KB | 1 | `.json` |
| plugin (any rung) | existing `marketplace-artifact-limits.ts` | | |

Links, devices and paths that escape the package directory are rejected
(reusing `sideload-filter.ts` and `zip-entry-path.ts`).

## 6. Resolution

### 6.1 Choosing a version

For a package row in one source snapshot:

1. Drop versions whose `engines.ave` does not include the app version.
2. Drop yanked versions (still shown in history).
3. Drop versions whose `platforms` excludes the current OS.
4. Drop versions whose rollout excludes this installation:
   `bucket = uint32(sha256("${installationId}:${sourceId}:${kind}:${name}:${version}")[0..4]) % 100`;
   eligible when `bucket < percent`.
5. Drop versions revoked by the official policy (official source only).
6. The highest remaining version is the **candidate**. If none remain but some
   were dropped only by `engines`, the row shows `upgrade_required` with the
   lowest app version that would satisfy the newest version's range.

### 6.2 Plugin artifact ladder

```
for rung in [release, archive, tree]:
  if rung not declared (and not conventional)      -> skip(rung, NOT_DECLARED)
  if rung in {release, archive} and no sha256 pin  -> skip(rung, ARTIFACT_NOT_PINNED)
  fetch rung
    release: https GET, follow redirects to the release host's CDN
    archive: https GET
    tree:    sparse checkout of `tree` at the version's commit
  on transport error                               -> fail(rung, SOURCE_UNREACHABLE / …) and continue
  verify
    release/archive: sha256(zip) == pin, zip limits, entry paths
    tree:            file rules, no links, digest computed (§6.4)
  on verification error                            -> fail(rung, ARTIFACT_DIGEST_MISMATCH / …) and continue
  stage -> check plugin.json name/version/engines/capabilities against the descriptor
  on mismatch                                      -> stop with MANIFEST_MISMATCH (do not try lower rungs)
  return staged artifact
stop with NO_INSTALLABLE_ARTIFACT(rungs[])
```

- "Conventional" means the release rung is also attempted for GitHub sources
  when the descriptor has `artifact.release.sha256` but no `tag`/`asset`: the
  defaults in §5.2 are used.
- A manifest mismatch stops the ladder: the package is inconsistent, and
  trying another rung would hide that.
- Every rung outcome (`used`, `skipped: reason`, `failed: code`) is part of the
  install plan shown to the user and is written to the receipt.

### 6.3 Official release flow

1. The plugin's own repository tags `vX.Y.Z` and its CI builds
   `{name}-{X.Y.Z}.zip` and uploads it as a release asset.
2. The official marketplace's `release-pin` workflow (or a human) opens a PR
   that sets `plugins/<name>/ave-package.json` `version`, `engines` and
   `artifact.release.sha256`, computed from the downloaded asset.
3. CI verifies the asset hash, unpacks it, checks `plugin.json` against the
   descriptor, and regenerates the index.
4. Merge = publish.

### 6.4 Tree digest

For the tree rung, `artifactSha256` is
`sha256` over the lines `"<mode> <sha256(file)> <path>\n"` for every file,
sorted by path bytes, with `mode` ∈ {`100644`, `100755`}. It is recorded in the
receipt and lets a later reinstall of the same version prove it got the same
bytes.

## 7. Source lifecycle

### 7.1 Add (preview → confirm)

1. **Parse** the input: `https://…`, `ssh://…`, `git@host:path`,
   `owner/repo` (expanded to `https://github.com/owner/repo.git`). Reject
   `file:`, `ext::`, credentials in the URL, and hosts blocked by policy.
   Plain `http://` is accepted only for a host listed in the managed policy's
   `marketplaces.allowHttpHosts` (internal git servers that have no TLS);
   dev/test builds may also allow loopback, as `cloudAllowPrivateNetwork`
   does today.
2. **Probe** with `git ls-remote` (token or SSH if configured). Auth failure
   returns `SOURCE_AUTH_REQUIRED` and the dialog asks for a token.
3. **Fetch** the ref into a temporary bare repo, sparse-read the root.
4. **Classify**: marketplace (index or conventional layout) → preview; single
   package (descriptor, `plugin.json`, `SKILL.md`, `server.json` at the root
   or the given subdir) → offer direct install; otherwise
   `SOURCE_NOT_A_MARKETPLACE`.
5. **Preview** returns: resolved commit, marketplace name and owner, package
   counts per kind, how many packages execute code (plugins + MCP), and
   validation diagnostics.
6. **Confirm** writes the entry, moves the temporary repo into place and
   publishes the snapshot. The id defaults to the index `name`, or is asked for
   if that is reserved or already taken.

### 7.2 Sync

Triggered after boot (non-blocking), every 6 hours while running, and manually.

```
fetch ref (partial, no tags except the ref)
candidate = resolved commit
if candidate == pin: done
if not is_ancestor(pin, candidate):
  official -> keep pin, SOURCE_HISTORY_REWRITTEN
  custom   -> keep pin, mark "history rewritten — review" until the user accepts
parse + validate index at candidate
  invalid -> keep pin, SOURCE_INDEX_INVALID
write snapshots/<candidate>.json, then atomically set pin = candidate
emit marketplace:catalog-changed
```

For the official source, the client tries the primary URL and then each
mirror; any of them may supply the candidate, and the history rule applies
unchanged.

### 7.3 Offline

The last good snapshot is served. Installing a package whose bytes are not
already fetched fails with `SOURCE_UNREACHABLE`; nothing falls back to a
different source.

### 7.4 Remove

Removing a source keeps the packages installed from it. They show
"source removed — no updates", and the Installed view offers uninstall.
Re-adding the same URL re-binds them.

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
- `plugin.json` → `kind: "plugin"`, `name`/`version` from it, `engines` from
  `extensions["ai.agent-connector.ave"].engines` (required; missing →
  `PACKAGE_COMPAT_UNDECLARED`). Artifact: release rung only if the repository
  at the pinned commit also holds a descriptor with `artifact.release.sha256`;
  otherwise the tree rung.
- `SKILL.md` / `AGENTS.md` → `version` from front matter if present, else
  `0.0.0+g<commit12>`; `engines` defaults to `*` for these non-executing kinds.
- `server.json` → `version` from the file.

A direct package updates when its ref moves to a descendant commit that
declares a higher version (or any new commit for synthesized `0.0.0+g…`
versions), after the same update review as marketplace packages.

## 9. Git runtime

### 9.1 Detection

```
mode = settings.marketplace.git.mode   // "auto" | "system" | "managed"
system: first `git` on PATH (plus /usr/bin/git, /opt/homebrew/bin/git,
        C:\Program Files\Git\cmd\git.exe); require `git --version` >= 2.27
managed: ~/.ave/runtime/git/<pinnedVersion>/ present and smoke-tested
auto: system if usable, else managed if present, else state "missing"
```

On macOS, `/usr/bin/git` without the Command Line Tools is a shim that opens an
installer dialog; detection runs `xcode-select -p` first and treats a missing
CLT as "no system git" instead of triggering the dialog.

### 9.2 Managed provisioning

```ts
// src/marketplace/git/managed-git-pins.ts — updated deliberately, reviewed like a dependency bump
const MANAGED_GIT = {
  version: "2.53.0",
  assets: {
    "darwin-arm64": { url: "https://github.com/desktop/dugite-native/releases/download/…-macOS-arm64.tar.gz", sha256: "…" },
    "darwin-x64":   { url: "…-macOS-x64.tar.gz",  sha256: "…" },
    "linux-x64":    { url: "…-ubuntu-x64.tar.gz", sha256: "…" },
    "linux-arm64":  { url: "…-ubuntu-arm64.tar.gz", sha256: "…" },
    "win32-x64":    { url: "https://github.com/git-for-windows/git/releases/download/…/MinGit-…-64-bit.zip", sha256: "…" },
    "win32-arm64":  { url: "…/MinGit-…-arm64.zip", sha256: "…" },
  },
} as const;
```

Phases reported to the UI: `checking → downloading(bytes) → verifying →
extracting → smoke-testing → ready | failed(code)`. Download goes through the
PAC-aware fetcher. Extraction goes to a temp directory and is renamed into
place. A failed or partial install never replaces a working one.

### 9.3 Invocation contract

Every call goes through one function, `runGit(args, { cwd, sourceId })`:

- env: `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=<host helper>`,
  `SSH_ASKPASS_REQUIRE=never`, `GIT_ALLOW_PROTOCOL=https:ssh` (plus `http`
  only when the source's host is in `marketplaces.allowHttpHosts`),
  `LC_ALL=C`; managed mode adds `GIT_CONFIG_NOSYSTEM=1`.
- config flags: `-c protocol.file.allow=never -c submodule.recurse=false
  -c core.fsmonitor=false -c core.hooksPath=<empty dir> -c http.proxy=<PAC>`.
- timeouts: `ls-remote` 20 s, `fetch` 120 s (configurable), `sparse-checkout` 60 s.
- output limits and abort signals follow the existing process helpers.
- Commands used: `ls-remote`, `init --bare`, `fetch --filter=blob:none --depth=<n>`,
  `rev-parse`, `merge-base --is-ancestor`, `cat-file`, `ls-tree`,
  `worktree add --no-checkout` + `sparse-checkout set --no-cone <paths>` +
  `checkout`, `archive` (tree export). Nothing else.

## 10. Official policy files

```ts
// policy/revocations.json
interface RevocationsFile {
  schemaVersion: 1;
  revocations: Array<{ kind: PackageKind; name: string; versions: string; // semver range
                        reason: string; at: string; action: "disable" | "uninstall" }>;
}

// policy/grants.json — replaces the signed whitelist's secret-gate grants
interface GrantsFile {
  schemaVersion: 1;
  grants: Array<{ plugin: string; versions: string; hostSecrets: string[]; reason: string }>;
}
```

They are read from the official snapshot only. A revoked installed version is
disabled at boot (existing revocation behavior) and the user is told why.
Custom sources cannot revoke or grant anything.

## 11. Service endpoint

```jsonc
// GET {serviceBase}/.well-known/former-service.json
{
  "schemaVersion": 1,
  "announcements": "/announcements/v1.json",   // path or absolute https URL on the same site
  "telemetry": null,                            // or "/telemetry/events" when an ingestion service exists
  "movedTo": null                               // or "https://new-domain.example" for a domain change
}
```

- `serviceBase` resolution: managed policy `service.baseUrl` → build constant
  `AVE_SERVICE_BASE_URL` (default `https://former-site.invalid`). There is no user
  setting.
- `movedTo` is honored when it comes from the current base over https; the new
  base is persisted in app state and used from then on. A later `movedTo`
  follows the same rule. Policy overrides always win.
- Announcements keep the `MarketplaceAnnouncement` contract (levels,
  `startsAt`/`endsAt`, up to three navigation-only actions, app-version
  filtered actions) and the dismissed-ids behavior. They are fetched after boot
  and every 6 hours.
- The static files live in the ave `web/` site (`web/public/.well-known/`
  and `web/public/announcements/`), deployed through its existing manual
  production gate.

## 12. Managed policy additions

```jsonc
// policy.json (system scope)
"marketplaces": {
  "allow": ["https://github.com/acme/*", "host:git.corp.example"],  // absent = no restriction
  "block": ["host:gitlab.com"],
  "allowHttpHosts": ["git.corp.example"],                              // plain-http git hosts; default none
  "allowDirectInstall": true,
  "allowDisablingOfficial": false,
  "additional": [{ "id": "corp", "url": "https://git.corp.example/ave/marketplace.git" }]
},
"service": { "baseUrl": "https://ave.corp.example" }
```

`additional` sources are pre-registered, cannot be removed by the user, and
count as `custom` for trust purposes.

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
| `ave:marketplace:package:detail` | `PackageKey` | `PackageDetail` (versions, compatibility, provenance, rung preview) |
| `ave:marketplace:install:plan` | `PackageKey & { version? }` | `InstallPlan` |
| `ave:marketplace:install:execute` | `{ planId }` | `InstallResult` |
| `ave:marketplace:update:plan` | `PackageKey` | `UpdatePlan` (commit range, capability delta) |
| `ave:marketplace:uninstall` | `PackageKey` | `UninstallResult` |
| `ave:marketplace:direct:preview` | `{ input; subdir?; ref? } \| { serverJson: string } \| { mcpConfig: string }` | `DirectPackagePreview` |
| `ave:git:runtime:status` | — | `GitRuntimeStatus` |
| `ave:git:runtime:install` | — | `GitRuntimeStatus` (progress via event) |

Events: `marketplace:sync-progress`, `marketplace:catalog-changed`,
`marketplace:install-progress` (`{ planId, rung, phase, bytes? }`),
`git-runtime:progress`.

All channels are host-renderer only (`validateHostRendererSender`), audited as
today, and `plan` ids are single-use and expire after 10 minutes. The existing
`ave:plugins:install-local` dev path is unchanged.

## 14. Error codes

| Code | When | User message (en key) |
|---|---|---|
| `GIT_RUNTIME_MISSING` | no usable git | `marketplace.error.gitMissing` |
| `GIT_RUNTIME_INSTALL_FAILED` | managed download/verify/extract failed | `marketplace.error.gitInstallFailed` |
| `SOURCE_URL_REJECTED` | scheme, credentials in URL, or policy | `marketplace.error.urlRejected` |
| `SOURCE_NAME_RESERVED` | reserved id | `marketplace.error.nameReserved` |
| `SOURCE_AUTH_REQUIRED` | 401/403, ssh denied | `marketplace.error.authRequired` |
| `SOURCE_UNREACHABLE` | network, DNS, timeout | `marketplace.error.unreachable` |
| `SOURCE_NOT_A_MARKETPLACE` | nothing recognizable | `marketplace.error.notMarketplace` |
| `SOURCE_INDEX_INVALID` | index failed validation | `marketplace.error.indexInvalid` |
| `SOURCE_HISTORY_REWRITTEN` | non-descendant candidate | `marketplace.error.historyRewritten` |
| `SOURCE_POLICY_BLOCKED` | managed policy | `marketplace.error.policyBlocked` |
| `PACKAGE_INCOMPATIBLE` | engines excludes app | `marketplace.error.incompatible` |
| `PACKAGE_COMPAT_UNDECLARED` | plugin without engines | `marketplace.error.compatUndeclared` |
| `PACKAGE_YANKED` / `PACKAGE_REVOKED` | install of a yanked/revoked version | `marketplace.error.yanked` / `.revoked` |
| `PLUGIN_ID_CONFLICT` | same plugin id installed from another source | `marketplace.error.idConflict` |
| `ARTIFACT_NOT_PINNED` | rung skipped: no sha256 in git | (rung detail) |
| `ARTIFACT_DIGEST_MISMATCH` | sha256 differs | (rung detail) |
| `MANIFEST_MISMATCH` | plugin.json vs descriptor | `marketplace.error.manifestMismatch` |
| `NO_INSTALLABLE_ARTIFACT` | every rung skipped or failed | `marketplace.error.noArtifact` |
| `CONTENT_RULE_VIOLATION` | content kind file rules | `marketplace.error.contentRule` |

## 15. UI specification

The mockup shows every state below. Settings → Marketplace becomes the in-app
store (the web store is gone).

### 15.1 Browse

- Header: search field, **Sources** menu (checkbox per enabled source, "All
  sources"), **Add** menu (Add marketplace…, Install from Git URL…, Add MCP
  server…).
- Kind tabs: Plugins, MCP, Skills, Agents, Themes, Fonts, Languages,
  Providers, Messaging — each with a count.
- Card: icon, display name, one-line description, **source badge**
  (`Ave Official` with a check glyph; custom sources show their id; internal
  hosts show a building glyph), version, state chip: `Install`, `Installed`,
  `Update 1.4.2`, `Requires Ave 0.12`, `Yanked`, `Source removed`.
- Same name in two sources: two cards, each with its own badge. No merged row.

### 15.2 Package detail (sheet)

Sections: overview; **Provenance** (source, repository, path, commit short SHA
with copy, published date); **Compatibility** (range and verdict);
**Permissions** (existing review summary for plugins/MCP); **Delivery** (the
rung list with the rung that will be used); **Versions** (history with yanked
and incompatible markers). Primary action follows the state chip.

### 15.3 Install progress

Inline in the sheet: rung rows with `skipped`/`failed`/`using` and a progress
bar for downloads; then the existing permission-review step; then result. A
failure shows every rung's reason and a copyable diagnostic.

### 15.4 Sources

Table: source (label, URL, origin badge), pinned commit (short SHA, relative
time of last sync), package count, status (`Up to date`, `Syncing`,
`Unreachable — showing cached`, `Auth required`, `History rewritten — review`),
enabled switch, overflow (Refresh, Set token, Remove). The official row has no
Remove and its switch is disabled unless policy allows. Policy-managed rows
show a lock.

### 15.5 Add marketplace dialog

Step 1: URL field (accepts `owner/repo`), optional ref, auth radio
(None / Token / SSH). Step 2 (preview): marketplace name, owner, commit, counts
per kind, "N packages can run code on this computer" warning, diagnostics,
id field. Confirm button: **Add marketplace**. If the input is a single
package, step 2 switches to the direct-install preview.

### 15.6 Update review

Commit range, version change, capability/network/secret delta highlighted,
and for custom sources a "history rewritten" banner that requires an explicit
checkbox.

### 15.7 Git runtime

A card in Settings → Marketplace → Maintenance and a blocking step inside the
Add dialog when git is missing: detected state (`System git 2.50.1`,
`Managed git 2.53.0`, `Not found`), mode selector (Auto / System / Managed),
**Install Git (≈40 MB)** with the phase progress from §9.2.

### 15.8 Announcements

Unchanged banner component; the only difference is the fetch origin.

### 15.9 Accessibility and copy

All dialogs are focus-trapped with labelled steps; source badges carry a text
label (not color alone); SHAs use monospace with a tooltip of the full value;
state chips use the existing token colors. New copy is added to the i18n
catalogs through the generator; no raw keys.

## 16. Migration mapping

| Today (server/app) | After |
|---|---|
| `GET /api/v1/catalog`, `/plugins/{slug}` | source snapshots |
| `…/download`, `…/download.sig` + `prod-v1` | ladder rungs + sha256 pins in git |
| `POST /plugins/{slug}/versions` + approval queue | PR + merge (D8) |
| yank / unyank / rollback | `versions[].yanked`, `policy/revocations.json`, new version |
| canary rollout percentage | `versions[].rollout.percent` + local bucket |
| `min_app_version` column | `engines.ave` in descriptor and plugin manifest |
| internal visibility (CIDR) | internal custom marketplace |
| organization-allowed flag | managed policy `marketplaces.allow` |
| announcements | service endpoint |
| telemetry `/telemetry/events`, `register-device` | service document `telemetry` (null until a collector exists) |
| DLP hit reporting, API keys, `/me` | removed with the server |
| signed whitelist / admission / revocation feeds | `policy/grants.json`, `policy/revocations.json` |
| hidden built-in themes (`MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS`) and locales | theme and language packages as data; `moonstone`, `gallery`, `en` stay built in |

Existing installs: on first boot of the new version, registry entries whose
`installSource` is `user` or `admin` and whose id exists in the official
snapshot are bound to `ave` (origin filled from the snapshot's matching
version, `rung: "legacy"` until the next update). Installed provider presets,
theme and language activations are converted to ledger entries.

## 17. Test plan

| Layer | What proves it |
|---|---|
| Schemas | fixture sets for every kind: valid, each invalid rule, unknown keys |
| Version choice | table tests for engines, yank, platform, rollout buckets, revocations |
| Ladder | each rung used/skipped/failed combination, mismatch stops the ladder, receipts carry rung outcomes |
| Git runtime | fake `git` binaries for version gates; env/flag contract; managed install with a local fixture server and wrong-hash rejection |
| Sync | local bare repos: fast-forward, rewrite (official refuse, custom review), invalid index keeps pin, mirror fallback |
| Identity | reserved names, cross-source same name, `PLUGIN_ID_CONFLICT`, update binding |
| Direct install | each detection branch; `server.json` mapping for npm/pypi/oci/remote |
| Service | `former-service.json` parsing, `movedTo`, policy override, announcements parity with today |
| E2E | packaged app adds a local-HTTP git marketplace, installs one package of each kind, updates, removes the source |
