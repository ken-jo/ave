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
| The app refuses to load an extension whose `requires.hostProtocol` is missing or not served. | `markIncompatibleHostProtocol` in `src/plugins/runtime/index.ts`, current version `HOST_PROTOCOL_VERSION` in `src/plugins/isolation/host-api-wire.ts` (`incompatible-host-protocol`) |

Both load refusals are not fixed by reinstalling: the same package fails the
same way. `incompatible-app-version` means update the app;
`incompatible-host-protocol` means the extension was built for a protocol
this app does not serve.

## What To Declare

Released hosts serve protocol `"3"`; published extensions currently declare:

```jsonc
"extensions": {
  "ai.agent-connector.ave": {
    "requires": { "hostProtocol": "3", "minAppVersion": "0.14.0" }
  }
}
```

**Upcoming, unreleased:** this development build serves protocol 5, which requires
host-issued loopback OAuth state and a declared worker control mode. Protocol 4 was
never released; released hosts move from 3 straight to 5. Do not publish protocol-5
packages for released protocol-3 hosts: the host-protocol declaration, independently
of `minAppVersion`, refuses an unserved contract. No first published app version
exists for protocol 5. Release preparation selects the actual minimum app version.
The current schema lives at `schemas/plugin-host-protocol/5/protocol.schema.json`
in the repository. The released protocol-3 schema stays frozen at
`web/public/schemas/plugin-host-protocol/3/v0.14.0/protocol.schema.json`.
See [protocol §3.3.1](../design/plugin-hostapi-protocol.md#331-host-validated-loopback-oauth),
[§3.3.2](../design/plugin-hostapi-protocol.md#332-worker-stdio-control-v1),
the [upcoming OAuth migration](./plugin-development.md#loopback-oauth-with-pkce)
and [delegated workers](./plugin-development.md#delegated-workers).
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
An extension repository copies the public types from an Ave git ref into
`contract/`. The repository also provides these authoring files:

- `src/plugins/public-contract.ts`
- `schemas/plugin-manifest.schema.json`
- `schemas/plugin-host-protocol/5/protocol.schema.json`

The public-type copy requires no signature or sha256 pin. Before protocol 5
ships, marketplace vendoring must switch from the release bundle to a git ref.
The v0.14.0 bundle remains available for existing consumers.

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
