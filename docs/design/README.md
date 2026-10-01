# Design

Status: Active English default. The Korean archive keeps earlier review history and original discussion, but this page must be usable on its own.

Korean archive: [docs/ko mirror](../ko/design/README.md).

## What This Page Owns

This page owns the current contract for Design. Use it as the first review surface when changing this area; use the archive for background, not as a substitute for current English guidance.

## Current Operating Contract

- English is the default review and contributor language for this app surface.
- The document must name the behavior that still matters today, the code or test locations that enforce it, and the conditions that make the note stale.
- Source files and tests are authoritative when this prose and implementation disagree.
- Korean-only material stays in the mirrored archive unless it is translated or summarized here.

## Pages In This Directory

- [Tiled chat groups](./tiled-chat-groups.md) — the source of truth for the main area's workbench model: up to four framed chat groups in work mode and one in chat mode, what is per group and what is per window, how `ave:chat:*` divides along that line, the split tree and its geometry, edge drops, gutter resizing, and the shape the work panel takes inside a tile. Change this page in the same commit that changes that behavior.
- [Multi-source git marketplace](./multi-source-git-marketplace.md) — contracts for the git-based marketplace: source registry and sync, `marketplace.json` and `ave-package.json` schemas, version choice, the extension artifact ladder, direct install, the git runtime, the service endpoint, IPC, error codes and UI states. Its mockup is [multi-source-git-marketplace.html](./multi-source-git-marketplace.html). Status: implemented.
- [Plugin HostApi as a versioned protocol](./plugin-hostapi-protocol.md) — decided; the wire and Lease steps shipped (v0.12.0) and the Publication step is planned in its §9.7 for 0.13.0: how the in-process `PluginHostApi` object becomes a published JSON-RPC protocol (`ave/host/*` beside MCP) so every code extension runs in its own confined process; the conversion table for all 48 members, secret handling, contract publication on top of the vendored contract, the migration steps with the wire step's implementation plan, the decisions taken and the removal condition for the in-process loader. Builds on `docs/blueprints/plugin-process-isolation.md`.
- [Plugin alerts](./plugin-alerts.md) — the host delivery contract for extension alerts: a manifest `alerts.kinds` declaration with typed slots and declared templates, `hostApi.raiseAlert` / `withdrawAlert` with typed results, the host pipeline (predecessor block, opt-in user toggles, upsert and closed state, cooldown, rate, card, OS notification after acceptance, audit), the per-extension settings section, the deprecation of `notificationEvents` and the alert use of `triggerConversation`, the dissolution of the vega-helper extension into `lyra-mail`, `meeting` and `orion-api`, retirement by an app-version-conditional revocation in a versioned snapshot, migration of user choices through retained config and `inherits` / `configInherits`, tests and the pull request plan. Status: proposed.
- [Extensions and plugins](./extensions-and-plugins.md) — the split of the single "plugin" concept: an extension is today's code package (`extensions["ai.agent-connector.ave"].entry`, HostApi, Lease and Admission) and a plugin is an Agent Plugins 1.0.0 bundle of skills, MCP servers, prompts, agent profiles, routine templates and hooks with no runtime code; the boundary rule, the plugin format and its Ave namespace, per-component trust and consent, no-code creation in the app, the `agent-plugin` marketplace kind and its older-app compatibility, the vocabulary migration that keeps every identifier, and the release slices after v0.11.0. Supersedes `../architecture/proposals/plugin-concept-vs-portable-standard.md`. Status: active; the vocabulary and marketplace kinds are implemented.
- The `.html` files here are static mockups kept as provenance for reviews that have already landed. They record a proposal at the time it was made and are not maintained against the shipped UI; read the markdown pages and the source for current behavior.

## Implementation Anchors

- `src/ui/renderer/components/PaneFrame.tsx` — the pane frame every tile is drawn in, whatever it holds — a conversation, a built-in view, settings, an extension surface: its header controls, the split tree, and the shared conversation action set
- `src/ui/renderer/App.tsx` — tile layout, focus, and the wiring from the sidebar to the tile holding a session
- `src/ui/renderer/components/Sidebar.tsx` — the Features and Extensions nav groups, each a flyout anchored to its row (the collapsed rail opens the same flyout from its icon; only the projects folder icon expands the sidebar), conversation and project rows, their actions, and the reveal-on-scroll list
- `src/ui/renderer/components/ChatSidePanel.tsx` — the work panel card and its tabs
- `src/ui/renderer/tabs/`
- `src/ui/renderer/__tests__/`

## Update Checklist

- State whether the document is active, implemented, superseded, or historical before adding new detail.
- Keep links relative to the current file depth; mirrored files under `docs/ko` need different paths from default docs.
- Add or update tests when a documented behavior is enforced by code.
- Remove template language and stale plan wording instead of carrying it forward.

## Related Entry Points

- [Ave Project Documentation](../README.md)
- [Getting Started](../guides/getting-started.md)

## Review Notes

This English page should let a reviewer understand scope, risk, and validation without opening the Korean archive. If the archive contains rationale that still matters, translate the relevant part into this page and keep the archive link as provenance.
