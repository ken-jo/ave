# Architecture

Status: Active. This is the index of the host's architecture pages. The product
goal they serve is in [Vision](../vision/README.md); the whole documentation map
is in the [documentation index](../README.md).

The host owns trust, storage, project identity, and tool execution. Extensions
and renderer surfaces ask for capabilities through manifests, the HostApi, and
IPC; they never reach host internals directly. The code entry points are
`src/main.ts`, `src/boot/`, `src/ipc/`, `src/preload/`, and
`src/plugins/runtime/`.

## Core

- [Architecture](./architecture.md): process boundaries, project identity, the
  conversation loop, providers, memory, the work board, the extension runtime,
  sub-agent messaging, tool governance, the OS execution sandbox, and security
  and audit. Start here for any non-trivial change.
- [Tool governance](./tool-governance.md): the single execution path every
  builtin, extension, MCP, and delegated-agent tool call takes.
- [Permission policy](./permission-policy-design.md): approvals, the reviewer,
  allowed directories, hooks, and the audit chain.
- [Session model v2](./session-model-v2.md): how sessions are stored, loaded,
  and restored.
- [Permission decision tree](./permission-decision-tree.md): the owner-approved
  quick reference and single source of truth for permission-decision work; read
  it alongside the [permission policy](./permission-policy-design.md).
- [File identity](./file-identity.md): identifying a file exactly by device and
  inode, and why those identifiers are persisted as decimal strings.

## Surfaces and runtime

- [Multi-surface conversation runtime](./multisurface-conversation-runtime.md):
  one conversation reached from the desktop, the headless host, paired devices,
  and messaging bridges.
- [OpenAI provider integration](./openai-provider-integration.md) and the
  [CLI subscription runtime](./claude-code-subscription-runtime.md): how
  provider connections plug into one engine.
- [Image preparation](./image-preparation.md): the `view_image` pipeline.
- [Native host secret encryption](./headless-secret-encryption.md):
  the native host's secret store.

## Documents

- [Document previews](./document-previews.md): the read-only table and page
  preview surfaces and their parsing budgets.
- [Document conversion engine](./document-observation-engine.md): the optional,
  replaceable engine that renders documents and recalculates workbooks offline.
- [Agent document tools](./agent-document-tools.md): the host builtins
  `read_document` and `open_document`.
- [XLSX editing](./xlsx-skill-editing.md): the `xlsx-edit` skill's sandbox-shell
  editing contract and read-only live view.

## Extensions, MCP, and hooks

- [Plugin deployment model](./plugin-deployment-model.md): install state,
  receipts, required installs, and updates.
- [MCP alignment](./mcp-alignment-design.md): extensions as MCP servers and the
  loopback topology.
- [Hook runtime](./hook-runtime-expansion-design.md): command hooks and
  lifecycle events.

## Decisions

- [Windows toast lifecycle ADR](./all-profile-windows-toast-lifecycle-adr.md)
  (proposed).
- [Hook runtime common-event parity](./hook-runtime-common-event-parity.md)
  (proposed).

### Proposals

- [Suggested replies](./proposals/suggested-replies-ghost-text.md): ghost-text
  reply suggestions in the composer (implemented).
- [Tailnet observer configuration surface](./proposals/tailnet-observer-config-surface.md)
  (implemented; kept as the decision record).

The git marketplace architecture lives in its
[design specification](../design/multi-source-git-marketplace.md) and
[blueprint](../blueprints/multi-source-git-marketplace.md).
