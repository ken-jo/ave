# Extension Deployment Model

Status: Active. Describes how installed extensions are stored, verified,
locked and updated, as the code does it today. Installs come from git
marketplaces ([design](../design/multi-source-git-marketplace.md)); the
earlier managed/user split, signed managed policy and separate `managed/` and
`user/` trees were never carried into this model and do not exist in code.

## No Privileged Packages

Every extension is installed the same way and lives in the same place. No
manifest field and no registry value protects an extension
([design §10](../design/multi-source-git-marketplace.md#10-no-privileged-packages)).
The manifest's former `installPolicy` and `publisher` fields are refused at
install (`src/marketplace/resolve/manifest-rules.ts`).

The only lock is the machine's system policy file
(`getAdminPolicyPath` in `src/permissions/policy-store.ts`):

| OS | Path |
|--|--|
| macOS | `/Library/Application Support/Ave/policy.json` |
| Windows | `%ProgramData%\Ave\policy.json` |
| Linux | `/etc/ave/policy.json` |

Its `marketplaces` section (`MarketplacePolicy`, `loadMarketplacePolicy` in
`src/marketplace/sources/policy.ts`) can allow or block sources, require
HTTPS, block private networks, gate direct installs and local folder sources, set the
`autoUpdate` mode, and list two kinds of boot installs
(`src/marketplace/boot-installs/`):

- `requiredInstalls`: installed at boot when missing and kept up to date. The
  user cannot uninstall or disable one. `PluginDeploymentGuard`
  (`src/plugins/deployment-guard.ts`) enforces this for the Plugins tab and
  `assertNotRequiredByPolicy` for the marketplace; both match the name and the
  source the entry names.
- `defaultInstalls`: installed once. The app's built-in defaults are
  `DEFAULT_INSTALLS` in `src/marketplace/boot-installs/default-installs.ts`;
  the policy can add more.
  Each applied default is recorded in `~/.ave/packages/default-installs.json`,
  so a user who uninstalls one does not get it back.

An unreadable `marketplaces` section fails closed.

## On Disk

All paths come from `resolvePluginPaths` (`src/plugins/plugin-paths.ts`). The
plugins root is `<AVE_HOME>/plugins`, with `AVE_HOME` defaulting to `~/.ave`
(`src/shared/ave-home.ts`); tests inject a `pluginsRoot`.

| Path under the plugins root | Owner | Contents |
|--|--|--|
| `registry.json` | `src/plugins/registry.ts` | One entry per installed extension |
| `<id>/` | `src/plugins/plugin-storage-layout.ts` | The installed payload (`plugin.json`, `dist/`, ...) plus host runtime dirs such as `data` and `storage` |
| `.cache/<id>/install-receipt.json` | `src/plugins/plugin-install-receipt.ts` | Per-file hashes of the installed payload |
| `.cache/<id>/<version>/`, `.cache/<id>/history.json` | `src/plugins/plugin-artifact-store.ts` | Manifest and registry entry kept per version |
| `.cache/plugin-retirement-journal.json` | `src/plugins/plugin-retirement-journal.ts` | Generations still being retired |
| `.cache/plugin-uninstall-cleanup.json` | `src/plugins/plugin-uninstall-cleanup-journal.ts` | Resumable uninstall cleanup |
| `+transactions+/removals/` | `src/plugins/plugin-removal-transaction.ts` | Journaled uninstall and install rollback |
| `+tombstones+/` | `src/plugins/installed-entry-fs.ts` | Removed payloads awaiting deletion |

Downloaded artifacts are cached by sha256
(`src/marketplace/resolve/artifact-cache.ts`).

## Registry

`registry.json` is host-owned. Writes go through `withRegistryTransaction`
in `src/plugins/registry.ts`: an in-process queue, a file lock and an atomic
write. Do not edit it by hand; `scripts/plugins-cli.ts` only lists it.

An entry carries the manifest path and its sha256, `enabled`,
`pendingUpdate` and `pendingCleanup`, and an `installSource`
(`PluginRegistryEntryInstallSource` in `src/plugins/types.ts`):

- `user`: an ordinary install.
- `local-dev`: a build folder installed from Settings in a development build
  ([Local Extension Development](../guides/local-plugin-development.md)).
- `admin`: legacy value; it grants nothing.

Older values are migrated when the registry is read (`dev-link` becomes
`local-dev`). A marketplace install also records an `origin`
(`PluginRegistryEntryOrigin`): `sourceId`, `sourceOrigin` (`official`,
`managed`, `custom` or `direct`), `commit`, `packagePath`, `version`, the
artifact `rung` and `artifactSha256`.

At boot the runtime ignores any entry whose manifest path resolves outside
the plugins root (`isTrustedRegistryManifestPath` in
`src/plugins/registry-manifest-trust.ts`) and logs
`ignoring untrusted registry manifest path for <id>`. A symlink to a checkout
elsewhere fails the same check.

## Install

1. **Resolve.** The marketplace picks the newest compatible version
   ([design §6.1](../design/multi-source-git-marketplace.md#61-choosing-a-version)).
2. **Stage.** `src/marketplace/resolve/plugin-ladder.ts` tries the release
   asset, then the archive, then the git tree. A release or archive is used
   only with a sha256 pin recorded at the snapshot commit; a folder source has
   a single `folder` rung. The staged `plugin.json` must match the package
   descriptor, including `requires.minAppVersion`, `requires.hostProtocol`
   and the authority fields, or the install stops with `MANIFEST_MISMATCH`
   (`assertGitInstallManifest`).
3. **Receipt.** The host hashes every staged payload file and builds the
   install receipt against the staged tree.
4. **Activate.** `PluginRuntime.activatePreparedArtifact`
   (`src/plugins/runtime/index.ts`) starts the candidate from the staged bytes
   and `PluginGenerationCoordinator`
   (`src/plugins/plugin-generation-coordinator.ts`) publishes it as the active
   generation. Only then are the payload, receipt and registry entry
   committed. The previous generation is retired through the retirement
   journal.

A local build-folder install (`installLocal` in `src/plugins/marketplace.ts`)
uses the same staged transaction. It requires development mode and refuses a
`process` extension.

## Load-Time Checks

Every load path runs the same gates in `src/plugins/runtime/index.ts`:

- **Receipt integrity.** `verifyInstallReceipt` re-hashes the payload. On a
  mismatch the extension is marked failed and not started, with the audit
  event `plugin_integrity_rejected`. Nothing is deleted.
- **Local installs.** A `local-dev` entry is refused when development mode is
  locked, which it always is in a packaged build.
- **App version.** `markIncompatibleAppVersion` refuses an extension whose
  `requires.minAppVersion` is newer than the app (`incompatible-app-version`).
- **Host protocol.** `markIncompatibleHostProtocol` refuses a missing or
  unserved `requires.hostProtocol` (`incompatible-host-protocol`).
- **Revocation.** `src/plugins/revocation/revocation-registry.ts` checks each
  source's `policy/revocations.json` from its snapshot and refuses revoked
  versions; it works offline.

None of these has a development bypass.

## Updates

- **Checking.** The `marketplace.updateCheckEnabled` setting (default on)
  controls update checks; `AVE_MARKETPLACE_UPDATE_CHECK=0` can only force them
  off (`src/plugins/update-detector.ts`).
- **Detection.** `src/marketplace/resolve/identity.ts` reports an update only
  for a strictly higher version, and `upgrade_required` when the newer
  version needs a newer app.
- **Classification.** `classifyUpdate` in
  `src/marketplace/updates/eligibility.ts`:
  - a required install is always applied automatically;
  - a changed consent fingerprint (`src/marketplace/updates/consent.ts`)
    needs the user's review;
  - a downgrade or source switch is never automatic (`not-an-upgrade`);
  - after three failed attempts (`MAX_AUTOMATIC_ATTEMPTS`) the update is
    marked failed;
  - otherwise the effective auto-update switch decides, with the policy's
    `autoUpdate` first.
- **Applying.** `src/marketplace/updates/apply.ts` applies queued updates
  while the conversation is idle and tells the user if no idle moment comes
  within 30 minutes (`ESCALATE_AFTER_MS`).
- **Interrupted replacement.** `src/plugins/marketplace-update-recovery.ts`
  keeps a `pendingUpdate` backup and restores it.

## Removal And Recovery

- `src/plugins/plugin-boot-recovery.ts` (`preparePluginRegistryForBoot`)
  migrates the registry, reconciles unfinished removal transactions, then
  recovers interrupted updates.
- `src/plugins/plugin-removal-transaction.ts` journals uninstall and install
  rollback so a crash mid-way is completed or undone at next boot.
- `src/plugins/plugin-uninstall-cleanup-journal.ts` finishes cleanup of an
  extension's config, secrets, auth partitions and cache.
- `src/plugins/orphan-uninstall-sweeper.ts` deletes leftover tombstones at
  boot.

## Tests

- `src/plugins/__tests__/registry-atomicity.test.ts`,
  `registry-manifest-path-trust.test.ts`, `load-time-bundle-integrity.test.ts`,
  `plugin-install-receipt-git.test.ts`, `install-local.test.ts`,
  `deployment-guard.test.ts`, `plugin-removal-transaction.test.ts`,
  `marketplace-update-recovery.test.ts`, `update-detector.test.ts`
- `src/plugins/revocation/__tests__/revocation-registry.test.ts`
- `src/marketplace/boot-installs/__tests__/run.test.ts`
- `src/marketplace/updates/__tests__/eligibility.test.ts`, `consent.test.ts`,
  `apply.test.ts`
- `src/marketplace/resolve/__tests__/plugin-ladder.test.ts`,
  `manifest-rules.test.ts`, `identity.test.ts`

## Related

- [Multi-source Git Marketplace design](../design/multi-source-git-marketplace.md)
- [Architecture: Extension Runtime](./architecture.md#extension-runtime)
- [Extension Development Guide](../guides/plugin-development.md)
- [Extension Version Quick Reference](../guides/plugin-version-quickref.md)
- [Publishing To A Git Marketplace](../guides/marketplace-publishing.md)
- [Product vision](../vision/README.md)
