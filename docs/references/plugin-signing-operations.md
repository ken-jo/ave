# Marketplace Artifact Trust Operations

Ave installs plugins from git marketplaces. There is no signing key, no
signed envelope and no upload API; what an install trusts is the commit it
synced and the pins that commit carries
([design](../design/multi-source-git-marketplace.md) §6).

1. A plugin package's `ave-package.json` pins its artifact: a GitHub release
   asset or an https archive by `sha256`, or the package's own tree at the
   version's commit.
2. The app syncs the marketplace, pins the commit it read, and plans the
   install from that commit only.
3. The ladder downloads the pinned zip (release, then archive) or packs the
   pinned tree, and checks the bytes against the pin. The staged `plugin.json`
   must match the descriptor's `minAppVersion` and authority fields
   (`MANIFEST_MISMATCH` otherwise), and may not declare the retired
   `installPolicy` or `publisher`.
4. The install writes a receipt (schema v4, `installSource: "git"`) with the
   artifact digest, the source, the snapshot and version commits, the rung
   outcomes and per-file SHA-256 values.
5. Runtime boot verifies the install receipt before parsing `plugin.json` or
   importing plugin code.

Plugin repositories do not generate signatures, and `@ave/plugin-sdk` carries
no trust keys: it is a type/source-only authoring contract.

## What an organization controls

- Which marketplaces a machine may reach (`marketplaces.allow` and `block` in
  the system policy file) and which it adds (`additional`).
- Which packages are installed once (`defaultInstalls`) or kept installed
  (`requiredInstalls`).
- Its own marketplace's branch protection, which is the publishing review.

A marketplace's `policy/revocations.json` disables or uninstalls only that
marketplace's installs.

## Local tamper detection

The install receipt records:

- plugin id and version
- the artifact SHA-256 (the pinned zip's hash, or the tree digest)
- the source, the snapshot and version commits, and each rung's outcome
- per-file SHA-256 values for the installed files

If any recorded file is missing or modified, the runtime rejects that plugin and
emits `plugin_integrity_rejected`. Receipts written before the git marketplace
(schema v3, `installSource: "marketplace"`) still verify.
