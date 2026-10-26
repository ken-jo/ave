# Extension Version Quick Reference

Status: Active. Covers the version and compatibility rules the app enforces
today.

## The Rules

| Rule | Where it is enforced |
|--|--|
| `version` in `plugin.json` is plain `MAJOR.MINOR.PATCH`, with no pre-release or build suffix. | `schemas/plugin-manifest.schema.json` |
| A package's versions strictly increase; the index lists them newest first. | `src/marketplace/catalog/validate.ts` |
| `requires.minAppVersion` is required for any marketplace install and must equal the descriptor's `minAppVersion`. | `assertGitInstallManifest` in `src/marketplace/resolve/manifest-rules.ts` (`PACKAGE_COMPAT_UNDECLARED`, `MANIFEST_MISMATCH`) |
| For a marketplace install, `requires.hostProtocol` must equal the descriptor's `hostProtocol`. | same |
| The app refuses to install a version whose `minAppVersion` is newer than the app. | `src/marketplace/resolve/descriptor.ts` (`PACKAGE_INCOMPATIBLE`) |
| The app refuses to load an extension whose `minAppVersion` is newer than the app. | `markIncompatibleAppVersion` in `src/plugins/runtime/index.ts` (`incompatible-app-version`) |
| The app refuses to load an extension whose `requires.hostProtocol` is missing or not served. | `markIncompatibleHostProtocol` in `src/plugins/runtime/index.ts`, served set `HOST_PROTOCOL_VERSIONS_SERVED` in `src/plugins/isolation/host-api-wire.ts` (`incompatible-host-protocol`) |
| `minAppVersion` must not be lower than the first app release that served the declared protocol. | `HOST_PROTOCOL_FIRST_APP_VERSION`, checked by `src/plugins/validate/validate-plugin.ts` and at marketplace install by `gitInstallManifestMismatches` in `src/marketplace/resolve/manifest-rules.ts` |

Both load refusals are not fixed by reinstalling: the same package fails the
same way. `incompatible-app-version` means update the app;
`incompatible-host-protocol` means the extension was built for a protocol
this app does not serve.

## What To Declare

The app serves host protocol `"4"` only. Protocol 4 requires host-issued state
for plugin loopback OAuth callbacks; protocol 3 and older packages are refused
before activation. The declaration is:

```jsonc
"extensions": {
  "ai.agent-connector.ave": {
    "requires": { "hostProtocol": "4", "minAppVersion": "0.15.0" }
  }
}
```

The validator's floor is `HOST_PROTOCOL_FIRST_APP_VERSION["4"] = "0.15.0"`.
A lower minimum fails validation. Follow the [OAuth migration](./plugin-development.md#loopback-oauth-with-pkce)
when re-vendoring from the app release tag. The version decision follows
[protocol §3.2 and §3.3.1](../design/plugin-hostapi-protocol.md#331-host-validated-loopback-oauth).
A `process` extension also follows the [entry rules](./plugin-development.md#entry-or-process).

When you start using a contract member that a later app release added, raise
`minAppVersion` to that release in both `plugin.json` and the package
descriptor (`ave-package.json`).

## Choosing The Number

| Change | Raise |
|--|--|
| Bug fix or internal cleanup | PATCH (`0.2.0` to `0.2.1`) |
| Compatible new feature | MINOR (`0.2.0` to `0.3.0`) |
| Breaking change, such as a tool signature change | MAJOR (`0.2.0` to `1.0.0`) |

A published version is never rebuilt or moved to another commit. To fix
something, publish a higher version.

## Vendoring The Contract

There is no separate SDK package; the contract version is the app version
([design §5.6](../design/multi-source-git-marketplace.md#56-plugin-contract-for-authors)).
An extension repository copies these files unchanged from an app release tag
into `contract/`:

- `src/plugins/public-contract.ts`
- `schemas/plugin-manifest.schema.json`
- `schemas/plugin-host-protocol/4/protocol.schema.json`

`contract/sources.json` records the repository, the tag and each file's
sha256. CI fails when the copy no longer matches those hashes, or when the
file at the recorded tag differs. Refresh by syncing from a newer tag; never
edit the copy.

## Releasing In The Official Marketplace

In `ken-jo/agent-marketplace`
([design §6.3](../design/multi-source-git-marketplace.md#63-official-release-flow)):

1. A pull request changes `plugins/<name>/source/` and raises `version` in
   `plugin.json` and `package.json` together. Validation fails if they differ
   or if the new version does not exceed every published one.
2. After merge, the release workflow builds `<name>-<version>.zip` from the
   merge commit and creates the `<name>-v<version>` tag and release. An
   existing tag is never rebuilt. Do not push tags yourself.
3. The workflow opens a pin pull request that writes the version,
   `minAppVersion`, `authority` and the release asset's sha256 into
   `plugins/<name>/ave-package.json`.
4. Merging the pin pull request publishes the version.

That repository's README owns the exact commands, including recovery when the
workflow fails after the tag exists. Other marketplaces follow their own
repository's rules.

During development, test a build from Settings without publishing
([Local Extension Development](./local-plugin-development.md)).

## Related

- [Extension Development Guide](./plugin-development.md)
- [Publishing To A Git Marketplace](./marketplace-publishing.md)
- [Local Extension Development](./local-plugin-development.md)
- [Multi-source Git Marketplace design](../design/multi-source-git-marketplace.md)
