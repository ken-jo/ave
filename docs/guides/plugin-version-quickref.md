# Extension Version Quickref

Status: Active English default. The Korean archive keeps earlier review history and original discussion, but this page must be usable on its own.

Korean archive: [docs/ko mirror](../ko/guides/plugin-version-quickref.md).

## What This Page Owns

This page owns extension compatibility rules, manifest version expectations, app release tag contract vendoring, and `requires.minAppVersion`. Use it as the first review surface when changing this area; use the archive for background, not as a substitute for current English guidance.

## Current Operating Contract

- English is the default review and contributor language for this app surface.
- The document must name the behavior that still matters today, the code or test locations that enforce it, and the conditions that make the note stale.
- Source files and tests are authoritative when this prose and implementation disagree.
- Korean-only material stays in the mirrored archive unless it is translated or summarized here.
- Extension repositories vendor `src/plugins/public-contract.ts`,
  `schemas/plugin-manifest.schema.json` and
  `schemas/plugin-host-protocol/3/protocol.schema.json` unchanged into `contract/`
  at an app release tag. `contract/sources.json` records the source
  repository, the tag and each file's hash.
  The official marketplace monorepo `ken-jo/agent-marketplace` shares one root
  `contract/` as `@ave/plugin-contract`; refresh it with
  `bun run contract:sync -- contract --ref <app tag> --app <ave checkout>`
  and verify it with `bun run contract:check`.
- An extension that uses a new contract member declares a supporting app release in
  `requires.minAppVersion`; the host enforces that minimum at install and load.
  The marketplace descriptor's `minAppVersion` must equal it.
- Official extensions are developed in `ken-jo/agent-marketplace` under
  `plugins/<name>/source/`. Raise `version` in `plugin.json` and `package.json`
  together (an extension for app 0.14.0 or later also declares
  `requires.hostProtocol: "3"` and `requires.minAppVersion: "0.14.0"`; apps
  0.12–0.13 used protocol `"2"` on the `ave/*` wire, which Ave rejects) and merge; the release workflow builds `<name>-<version>.zip`, tags
  `<name>-v<version>`, and opens a pull request that pins the zip's sha256 in
  the descriptor. Merging that pull request publishes the version. Versions
  strictly increase and a published version never moves to another commit.
  Per-plugin tag pushes and the central `former_org/.github` workflows are
  not part of this flow.

## Implementation Anchors

- `package.json`
- `src/plugins/`
- `src/main/`
- `src/ui/renderer/`

## Update Checklist

- State whether the document is active, implemented, superseded, or historical before adding new detail.
- Keep links relative to the current file depth; mirrored files under `docs/ko` need different paths from default docs.
- Add or update tests when a documented behavior is enforced by code.
- Remove template language and stale plan wording instead of carrying it forward.

## Related Entry Points

- [Ave Project Documentation](../README.md)
- [Getting Started](./getting-started.md)

## Review Notes

This English page should let a reviewer understand scope, risk, and validation without opening the Korean archive. If the archive contains rationale that still matters, translate the relevant part into this page and keep the archive link as provenance.
