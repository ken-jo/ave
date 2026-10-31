# Publishing To A Git Marketplace

Status: **Active** (2026-09-25). Replaces the server marketplace's publisher
flow, which was removed by the switch to the
[multi-source git marketplace](../blueprints/multi-source-git-marketplace.md).

A marketplace is a git repository. The app reads it over git, pins what it read
to a commit, and installs a package only from bytes that commit names. There is
no upload, no approval queue and no publisher key: publishing is a merge, and
the repository's branch protection is the review. The
[design specification](../design/multi-source-git-marketplace.md) owns every
format below; this page is the author's route through it.

## Which Marketplace

| Source | Who adds it | What it can do |
|---|---|---|
| Official (`ave`) | built into the app | the only source whose extensions can receive host-secret grants (§10.3) |
| Managed | the machine's system policy file (`marketplaces.additional`) | its packages can be listed in the policy's `defaultInstalls` and `requiredInstalls` |
| Custom | the user, in Settings → Marketplace → Add | ordinary installs |
| Direct | the user, from one git folder | one package, no index |

Every source is equal in what its packages may do at run time. No package can
lock itself, grant itself a secret, or revoke another source's packages.

## Repository Layout

```
marketplace.json                 the index (schemas/marketplace/index.schema.json)
policy/revocations.json          optional (schemas/marketplace/revocations.schema.json)
<kind dir>/<name>/ave-package.json   one descriptor per package (package.schema.json)
<kind dir>/<name>/...            the package's files
```

`marketplace.json` is the one index file. It carries its format version as
`schemaVersion: 2`; the app refuses any other value. It names the marketplace
and lists each package's `kind`,
`name` and `path`. A package entry may also carry `versions[]` (newest first),
each pinning a `version` to the `commit` that published it; without
`versions[]` the app reads the descriptor at the synced commit. The kinds are
`plugin`, `mcp`, `skill`, `agent`, `theme`, `font`, `language`, `provider` and
`messaging-connection`. Names are lowercase, hyphenated and unique per kind
within a marketplace.

`ave-package.json` carries `schemaVersion: 2`, `kind`, `name`, `version`,
`minAppVersion` and a kind-specific `payload`:

| Kind | Payload and files |
|---|---|
| `skill` | `entry: "SKILL.md"`; `scripts/`, `references/`, `assets/`, `LICENSE`, `NOTICE` |
| `agent` | `entry: "AGENTS.md"` only |
| `theme` | `entry: "theme.json"` and an optional preview image; contrast rules are enforced |
| `font` | `entry: "font.json"`, `LICENSE` and font files under `files/` (`.woff2`, `.woff`, `.ttf`, `.otf`) |
| `language` | `locale`, `language.json` and `messages.json` (interface keys of the English catalog only) |
| `provider` | `entry: "provider.json"` (a provider preset) |
| `messaging-connection` | `entry: "connection.json"` |
| `mcp` | `server` (stdio launcher `npx`/`uvx`/`docker` with an exact version, a package-local `server/…` command, or Streamable HTTP), or `serverJson` naming an official MCP `server.json` |
| `plugin` | `authority` (copied from `plugin.json`) and `artifact` pins |

SVG is refused in every kind. Size and file-count limits are in design §5.4.

## Extensions

An extension's `artifact` says where its bytes come from. The app tries, in order:

1. `release` — a GitHub release asset, used only with a `sha256` pin;
2. `archive` — an https zip, used only with a `sha256` pin;
3. `tree` — the package's `plugin.json`, `dist/` and `assets/` at the pinned
   commit (nothing else may sit there).

A transport or checksum failure moves to the next rung. A staged `plugin.json`
that disagrees with the descriptor stops the install (`MANIFEST_MISMATCH`):
`extensions["ai.agent-connector.ave"].requires.minAppVersion` is required and must equal
the descriptor's `minAppVersion`, and every authority field (`capabilities`,
`networkAccess`, `hostSecrets`, `pluginAccess`, `auth`, `requires`) must equal
the descriptor's copy. A manifest that still declares `installPolicy` or
`publisher` is refused by name: neither field exists any more.

Only an official extension installed from the release or archive its snapshot
pins can receive a host-secret grant, and only for the keys the app's
`HOST_SECRET_GRANTS` table lists; a tree install never does (design §10.3).

## MCP Servers

An MCP package installs a server configuration, not code the app runs itself.
Launcher packages must pin an exact version (`@scope/name@1.2.3`,
`name==1.2.3`, an image tag other than `latest` or a digest). A package-local
command runs from the package's `server/` files at the pinned commit;
`$PLUGIN_DIR`, `$DATA_DIR` (`~/.ave/mcp-data/<name>`, kept across updates)
and `$NODE` are filled in at install. MCP governance still decides whether the
server may be configured: a machine whose governance policy does not approve
it answers `PACKAGE_POLICY_BLOCKED`.

## Updating, Yanking And Revoking

- **Update:** publish a new `version`; users see it after their next sync.
  The update review shows the commit range and any change in authority; new
  network hosts, secrets or capabilities need the user's explicit decision.
- **Yank:** add `yanked: { reason, at }` to a `versions[]` entry. A yanked
  version is not offered; installs of it stay.
- **Staged rollout:** `rollout: { percent }` on a version; pre-release
  versions reach only users who opted into canary builds.
- **Revoke:** list `{ kind, name, versions, reason, at, action }` in
  `policy/revocations.json`. It applies only to installs from this source;
  `action` is `disable` or `uninstall`.

Published versions are immutable apart from `yanked` and `rollout`.

## Checking A Repository

The app's own rules are exported as `checkMarketplaceRepository`
(`src/marketplace/repository-check.ts`). The official repository vendors it
(`tools/vendor/`) and runs it in CI with its extra rules; any marketplace can
do the same. An empty result means the app accepts every package as it stands.

Pass `alertsReleaseVersion` in the check options: the published stable app
version carrying the complete alerts contract. Missing or invalid configuration
fails the check. Keep this value fixed across later app releases; the
[release checklist](../development/release-process.md#alerts-release-publication)
owns its publication-time selection. Supply `releasedManifests` when checking
release artifacts, including release-only packages whose minimum app version is
at or above that threshold. The checker refuses `notificationEvents` on eligible
tree and supplied release manifests, including an empty declaration. Older
published artifacts retain their historical threshold treatment; an installed
manifest carrying the field loads after the host drops it with a warning.

## Linking To A Package

`ave://install/<kind>/<name>@<source>` and
`ave://uninstall/<kind>/<name>@<source>` open the Marketplace tab on that
package; `ave://marketplace/add?url=<repository>` opens the add dialog. Each
link only opens a screen the user confirms. The server-era
`ave://install/<slug>` form is ignored.

## Organizations

An administrator adds an internal marketplace and requires packages from it
through the system policy file's `marketplaces` section (design §12):
`additional` registers the source, `defaultInstalls` installs a package once,
and `requiredInstalls` keeps a package installed and updated and prevents its
uninstall or disable. A required entry locks only the package installed from
the source it names.

## Implementation Anchors

- `schemas/marketplace/*.schema.json`
- `src/marketplace/catalog/validate.ts` — index and descriptor validation
- `src/marketplace/content/kinds.ts`, `src/marketplace/content/rules.ts` — content kinds
- `src/marketplace/resolve/plugin-ladder.ts`, `src/marketplace/resolve/manifest-rules.ts` — extensions
- `src/marketplace/resolve/mcp.ts` — MCP servers
- `src/marketplace/repository-check.ts` — the repository check
- `src/marketplace/sources/policy.ts` — the system policy file
