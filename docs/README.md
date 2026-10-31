# Ave Project Documentation

Hello, I'm Ave: a comprehensive agent browser where you, your agents, the models
you choose, and your computer meet. What Ave is and where it is going is stated
once, in [Vision](./vision/README.md); every other page links there instead of
restating it.

Read the sections in order: the goal, the architecture that serves it, the
guides for using and extending Ave, the reference contracts that code and tests
hold to, and the decision records behind them. Source files and tests win when a
page drifts from the code.

## 1. Vision

- [Vision](./vision/README.md): the goal (agent browser, terminal, and one
  platform for chat, extensions, skills, and remote) and what ships today.
- [Philosophy](./vision/philosophy.md): the principles behind the goal.

## 2. Architecture

How the host is built. Start with the [architecture index](./architecture/README.md).

- [Architecture](./architecture/architecture.md): host, renderer, IPC, storage,
  extensions, tool governance, security and audit.
- [Tool governance](./architecture/tool-governance.md) and
  [permission policy](./architecture/permission-policy-design.md): how a tool
  call is exposed, approved, reviewed, audited, and executed.
- [Tiled chat groups](./design/tiled-chat-groups.md) and the
  [visual design system](./DESIGN.md): the workbench where chat, the work panel,
  the browser, and the terminal live.
- [Multi-surface conversation runtime](./architecture/multisurface-conversation-runtime.md):
  remote surfaces, the headless host, and paired devices.
- Extensions: [extensions and plugins](./design/extensions-and-plugins.md),
  [HostApi protocol](./design/plugin-hostapi-protocol.md),
  [plugin process isolation](./blueprints/plugin-process-isolation.md),
  [deployment model](./architecture/plugin-deployment-model.md), and the
  [git marketplace](./design/multi-source-git-marketplace.md).

## 3. Guides

- [Getting started](./guides/getting-started.md): build, run, connect a provider.
- [User hooks](./guides/user-hooks.md): configuration, event JSON, command decisions, permissions, and failures.
- [Windows setup](./guides/windows-setup.md) and the
  [native Linux host](./guides/native-server.md).
- [Telegram bridge](./guides/telegram-bridge.md): reach a conversation from a
  private chat.
- Building extensions: [extension development](./guides/plugin-development.md),
  [local development](./guides/local-plugin-development.md),
  [version quickref](./guides/plugin-version-quickref.md),
  [MCP app cards](./guides/mcp-app-authoring.md),
  [testing a marketplace locally](./guides/local-marketplace-testing.md), and
  [publishing to a git marketplace](./guides/marketplace-publishing.md).
- Releasing: [release process](./development/release-process.md),
  [production release checklist](./references/production-release-checklist.md),
  and the [R2 release channel](./guides/release-r2.md).

## 4. Reference and contracts

Pages that code, tests, or scripts read or cite by section. Change them in the
same commit as the behavior they describe.

| Area | Pages |
| --- | --- |
| Protocols | [A2A exact send replay](./protocols/ave-a2a-exact-send-replay.md) (pinned by `bun run check:a2a-p4-5-contract` together with the [A2A blueprint](./blueprints/a2a-subagent-messaging.md)) |
| Extensions | [Plugin tool schema](./references/plugin-tool-schema-design.md), [overlay triggers and alerts](./references/overlay-trigger.md), [plugin alerts](./design/plugin-alerts.md), [marketplace trust operations](./references/plugin-signing-operations.md) |
| Tools and models | [Development handbook](./development/README.md) (tool, skill and MCP loading policies, plus remote MCP authentication), [tool-level deferral](./development/tool-level-deferral-design.md), [MCP alignment](./architecture/mcp-alignment-design.md), [hook runtime](./architecture/hook-runtime-expansion-design.md), [tool result kinds](./references/tool-result-kind-sentinels.md), [model capability catalog](./design/model-capability-catalog.md), [model upgrade verification](./development/model-upgrade-verification.md) |
| Providers and runtime | [OpenAI provider integration](./architecture/openai-provider-integration.md), [CLI subscription runtime](./architecture/claude-code-subscription-runtime.md), [session model v2](./architecture/session-model-v2.md), [image preparation](./architecture/image-preparation.md), [native host secret encryption](./architecture/headless-secret-encryption.md) |
| Development | [Theme system](./development/theme-system.md), [observability](./references/observability-guide.md), [main-process bundle budget](./development/main-process-bundle.md), [knip baseline](./development/knip-baseline.md), [legacy sunset policy](./development/legacy-sunset-policy.md) and its [inventory](./development/legacy-sunset-inventory.json) |

`scripts/hooks/documentation-references.json` lists every document that code
reads (`consumed`) or names (`referencedOnly`); moving or deleting one of those
needs the same change there and in the code that names it.

## 5. Decisions

Plans, proposals, and research. Each page states its status (proposed,
implemented, superseded) at the top.

- [Blueprints](./blueprints/README.md): staged plans, such as the A2A messaging
  blueprint, the git marketplace phases, and headless relay separation.
- Proposals, listed in the [architecture index](./architecture/README.md#proposals):
  suggested replies, reviewer re-adjudication, declared-category removal, and
  the Tailnet observer configuration surface.
- Architecture decisions: [Windows toast lifecycle](./architecture/all-profile-windows-toast-lifecycle-adr.md),
  [hook runtime event parity](./architecture/hook-runtime-common-event-parity.md).
- Research: [OS sandbox isolation](./research/sandbox-isolation.md) and
  [network-restricted evaluation](./research/network-restricted-eval.md).

Closed-out phase reports, superseded plans, and mockups of shipped UI are
deleted rather than archived; git history keeps them.

## Language policy

English is the documentation language; the source and these English pages are
authoritative.
