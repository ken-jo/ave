# Design

Status: Active. Design specifications for user-facing surfaces and extension
contracts. The visual design system for the whole app is
[DESIGN.md](../DESIGN.md); the documentation map is in the
[documentation index](../README.md).

## Pages in this directory

- [Tiled chat groups](./tiled-chat-groups.md): the workbench model of the main
  area. Up to four framed chat groups on a wide canvas and the focused group on
  a narrow canvas; what is per group and what is per window; how `ave:chat:*`
  divides along that line; the split tree, edge drops, gutter resizing, and
  the work panel inside a tile.
  Change it in the same commit that changes that behavior. Implemented.
- [Extensions and plugins](./extensions-and-plugins.md): an extension is a code
  package (HostApi, Lease, Admission); a plugin is a code-free bundle of skills,
  MCP servers, prompts, agent profiles, routine templates, and hooks. The
  boundary rule, per-component trust and consent, and the marketplace kinds.
  Active; vocabulary and marketplace kinds implemented.
- [Plugin HostApi as a versioned protocol](./plugin-hostapi-protocol.md): the
  in-process HostApi turned into a published JSON-RPC protocol (`ave/host/*`
  beside MCP) so every code extension runs in its own confined process. The app
  serves host protocol `"3"`. Read by tests and scripts; source comments cite its
  sections.
- [Multi-source git marketplace](./multi-source-git-marketplace.md): source
  registry and sync, the `marketplace.json` and `ave-package.json` schemas,
  version choice, the artifact ladder, direct install, IPC, error codes, and UI
  states. Implemented; CI and source cite §18.4.1.
- [Plugin alerts](./plugin-alerts.md): the host delivery contract for extension
  alerts (`alerts.kinds`, `raiseAlert` / `withdrawAlert`, the host pipeline, and
  the rollout plan). Proposed.
- [Model capability catalog](./model-capability-catalog.md): one typed record of
  each model's limits, modalities, reasoning controls, and prices, generated with
  recorded provenance. Decided and implemented in slices.
- [Permissions: always-allow baseline and judge slot](./permissions-always-allow-and-judge.md):
  the rules language (`Bash(<prefix> *)`, `Edit`, `WebFetch(domain:)`, `Mcp`),
  deny > ask > allow precedence, the AST shell matcher, per-project rule files,
  hard floors, and the `PermissionJudge` slot. Decided; P1a implemented.
- [Permission review scenario board](./permission-review-scenario-board-v2.html):
  the reviewer scenarios that
  `src/permissions/__tests__/permission-review-scenario-board.test.ts` reads.
  Keep it in step with that test.

Static mockups of shipped UI are not kept here; read the markdown pages and the
source for current behavior.

The renderer anchors for these pages are `src/ui/renderer/components/PaneFrame.tsx`
(the pane frame of every tile), `src/ui/renderer/App.tsx` (tile layout and
focus), `src/ui/renderer/components/Sidebar.tsx` (navigation),
`src/ui/renderer/components/ChatSidePanel.tsx` (the work panel), and
`src/ui/renderer/tabs/`.
