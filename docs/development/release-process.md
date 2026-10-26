# Release Process

Status: Active. This page owns release readiness for the desktop app: the
public tag profile, the release asset set, alerts and protocol publication, and
the protocol candidate between releases. The operator checklist is
[Production Release Checklist](../references/production-release-checklist.md);
the download and update channel is [R2 Release Channel](../guides/release-r2.md).
Source files and workflows win when this page drifts: `package.json`
(`aveRelease`, `build`), `.github/workflows/build-installers.yml`,
`scripts/release.mjs`.

## Settings relaunch and downloaded updates

`src/main/auto-updater.ts` preserves the updater's normal automatic installation
on quit. Reserving a settings relaunch synchronously sets
`autoInstallOnAppQuit = false` before scheduling the relaunch or entering quit
cleanup. This restart applies the requested settings without installing an
unrelated downloaded update. Cancelling the reservation restores the previous
value; stopping the updater during accepted quit cleanup leaves it disabled for
that quit. Explicit update installation remains refused during the reservation.

Installed package changes share one admission counter in
`src/main/installed-state-mutation.ts`. Content operations hold admission from
queue entry through payload writes, ledger publication, activation/deactivation
and rollback or removal. Direct ledger writes hold it through disk and memory
publication. Server package operations hold it through config, files, records
and rollback; plugin registry transactions hold it through queue and file-lock
release. Existing plugin lifecycle locks additionally cover the surrounding
plugin operation. Marketplace install wrappers share this counter and retain
admission across staging, multiple stores, migration and boot bookkeeping.
Deferred deletion of retired content acquires a separate admission after
retirement; a reserved relaunch leaves these unused files for the next boot
sweep instead of delaying shutdown for a live generation's retirement.

## Immutable Public Tag Release Profile

The current public tag profile is deliberately **unsigned only**. The
`release-profile` job checks the tagged `package.json#aveRelease` only after
checking out the immutable GitHub event SHA. It fails unless the tag is exactly
`v` plus `package.json.version`, `tagDistribution` is `public`, and `signing`
is `unsigned`.

- Tag installers are checked out at `github.sha`, verify `HEAD` matches that
  SHA, and always use `--skip-code-sign`.
- Before a public tag is pushed, an active `v*` tag ruleset must prohibit
  creation, updates, and deletions, and permit bypass only for designated
  release operators. The workflow fails closed unless
  `github.ref_protected` is true, and the publisher re-reads the annotated
  tag's peeled commit through the GitHub API immediately before attaching the
  draft Release assets. It must still equal `github.sha`.
- `workflow_dispatch` remains an unsigned candidate and never creates a
  GitHub Release.
- The draft uses the tracked unsigned disclosure template. Publishing stays a
  manual step: the operator checks the draft's assets and body, then takes it
  out of draft.

### Release asset set

The `publish-release` job attaches exactly the files the `installers` matrix
uploads (`.github/workflows/build-installers.yml`, `Upload installers`), named by
the `artifactName` patterns in `package.json#build`. A complete draft has 13
assets: ten versioned installers and blockmaps, plus the three
electron-updater metadata files:

| Platform | Assets |
| --- | --- |
| macOS (`dmg`, `zip`) | `Ave-X.Y.Z-mac-arm64.dmg`, `.dmg.blockmap`, `Ave-X.Y.Z-mac-arm64.zip`, `.zip.blockmap`, `latest-mac.yml` |
| Windows (`nsis`, `zip`) | `Ave-X.Y.Z-windows-x64-setup.exe`, `.exe.blockmap`, `Ave-X.Y.Z-win-x64.zip`, `latest.yml` |
| Linux (`AppImage`, `deb`, `rpm`) | `Ave-X.Y.Z-linux-x86_64.AppImage`, `Ave-X.Y.Z-linux-amd64.deb`, `Ave-X.Y.Z-linux-x86_64.rpm`, `latest-linux.yml` |

GitHub records a `sha256` digest for every asset, and the `latest*.yml` files
carry the `sha512` that electron-updater verifies. The draft Release is the
secondary record; the source repository is private, so installed apps never
read it.

The `publish-r2` job uploads the same files to the Cloudflare R2 release
channel, which is what installed apps update from (`package.json`
`build.publish`) and what the website's download buttons link to
(`latest/<platform>` aliases). Layout, order, headers, owner setup and release
verification: [R2 Release Channel](../guides/release-r2.md).

A future signed/notarized release requires a separate reviewed workflow and
positive platform signature/notarization evidence. It must not be enabled by
adding secrets to this unsigned workflow.

## Alerts release publication

The alerts release is the version carrying the complete
[alerts rollout](../design/plugin-alerts.md#pull-request-plan), not a guessed
version from the design example. At publication:

1. Record that stable version in the marketplace CI caller's
   `RepositoryCheckOptions.alertsReleaseVersion`, alongside successor plugin
   `minAppVersion` and conditional revocation `appVersions`.
2. Re-vendor the repository checker and update its caller in the same marketplace
   change. The option is required and validated at runtime: missing, malformed,
   pre-release or build-suffixed values produce a repository problem before any
   package is checked. There is no default threshold that silently disables the
   rule or prematurely chooses a release number.
3. Supply `releasedManifests` for published artifacts. The checker examines tree
   manifests and supplied release manifests against the matching descriptor or
   index minimum version. An eligible release-only package without manifest
   evidence fails the check. A `notificationEvents` declaration at or above the
   threshold is refused even when its array is empty. Older package artifacts
   retain their historical threshold treatment.
4. Include the new-mail and meeting-summary opt-in loss in the release notes.
   The 0.13.0 installer draft must remain unpublished until `local-indexer` has
   published a version on the alert contract. Confirm the published artifact's
   manifest declares `alerts.kinds` and `requires.hostProtocol: "2"`, and record
   its version and tag in the release evidence before publishing the installer.
   The host then drops
   `notificationEvents` from installed manifests with one warning per extension,
   before strict validation, rather than refusing the whole installed manifest.

The explicit caller option lets publication select the actual release once and
keeps the same checker usable by every source. Updating the app's own package
version cannot move the deprecation threshold on later releases.

## Protocol 2 release rollback

The v0.12.0 app serves host protocol 2. Keep its installer release as a draft
until the published extension replacements and packaged upgrade matrix pass the
release checks in the [host protocol design](../design/plugin-hostapi-protocol.md).
If those checks fail, leave the release as a draft and supersede it with a new
tag. Never change the bytes behind the existing tag or its schema URL. Published
extension artifacts stay available: older apps still select their older versions
from the frozen legacy marketplace index. Promote the protocol-2 web schema
alias only after the app draft is published, in a `web`-only change that runs
`node scripts/sync-plugin-host-protocol-mirror.mjs --publish 2/<version>`. The
command marks the tag-named mirror copy published and points the `2` alias at
the newest published copy of protocol 2, so promoting an older copy after a
newer one leaves the alias on the newer copy.
`check:plugin-host-protocol-mirror` refuses an alias that names any other copy,
whether or not a candidate is open.

## Between releases: the next protocol candidate

Once a release is tagged, its protocol schema copy is frozen, and
`check:plugin-host-protocol-mirror` refuses any change to the canonical schema
that would alter it: a recorded copy whose version has a `v<version>` tag in the
checkout must be the bytes that tag carries, published or not. The first
change after the tag therefore bumps `package.json` to the next version (patch
or minor, per the release plan). It regenerates the schema with
`bun run generate:plugin-host-protocol-schema` and runs
`node scripts/sync-plugin-host-protocol-mirror.mjs`, which records a new
candidate copy with `publishedTag: null`. Later protocol changes refresh only
that candidate. The previous release's copy keeps its recorded bytes until its
own publication marks it published with the `--publish` command above, which may
run after this bump. The release PR then folds the changelog and
regenerates the candidate once more at the final commit.
