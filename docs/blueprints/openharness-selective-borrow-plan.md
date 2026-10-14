# OpenHarness Selective Borrow Record

Status: Executed. Under the MIT license, selected patterns from HKUDS/OpenHarness were ported to TypeScript. The project is not forked, and there is no runtime dependency on it. This page is the borrow inventory that `LICENSE` points to.

Upstream: [HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness), a Python agent harness under the MIT License.

## 1. Decision

A full fork was rejected. The upstream is a Python terminal application for developers. Ave is an Electron desktop app with its own plugin, marketplace and permission model ([vision](../vision/README.md)). Only self-contained safety and tool-contract patterns were ported, rewritten in TypeScript, and adapted to Ave's contracts.

## 2. Borrowed and still in the code

Each file below carries the attribution header in section 4.

| Pattern | Upstream source | Where it lives now |
|---|---|---|
| Credential and sensitive-path blocklist with the trailing-slash match helper (`policyMatchPaths`) | `permissions/checker.py` | `src/permissions/sensitive-paths.ts` |
| Tool base contract: schema-typed tools with a per-tool `isReadOnly` declaration | `tools/base.py` | `src/tools/base.ts` |
| Non-interactive shell execution: preflight rejection of interactive scaffolds, partial-output drain on timeout, terminate-then-kill ladder, output cap | `tools/bash_tool.py` | The bash sections of `src/tools/shell-tools.ts` (formerly `src/tools/bash.ts`) |
| SSRF defense: URL validation, private, loopback, link-local and unique-local address blocklist (IPv4, IPv6, IPv4-mapped), per-hop redirect validation | `utils/network_guard.py` | `src/core/network-guard.ts` |
| Symlink-safe path boundary check | `sandbox/path_validator.py` | `src/sandbox/path-validator.ts` |
| Sensitive-path hard-block regression fixtures | `permissions/checker.py` | One `describe` block in `src/tools/__tests__/executor.test.ts` |

Behavior that follows the borrowed design but is not copied code:

- The read-only short-circuit in `src/permissions/approval-gate.ts`, driven by the tool's `isReadOnly`.

## 3. Ported once, no longer present

These were ported originally and later removed or replaced with Ave code that carries no attribution:

- The untrusted-content banner helper. There is no `src/tools/untrusted-banner.ts`. `wrapUntrusted` in `src/alerts/render.ts` is Ave's own code.
- External HTTP hooks. `src/hooks/hook-config.ts` accepts only `type: "command"` handlers.
- `zod-to-json-schema`. Tool schemas use zod 4's built-in `z.toJSONSchema` (`src/tools/base.ts`).

`src/tools/safe-env.ts` is Ave's own code. No matching upstream source was identified, so it carries no attribution.

Not borrowed: the upstream plugin specification, terminal UI, voice tools, chat-channel gateways, slash commands, swarm coordination, container sandbox backend, and MCP client. Ave has its own designs for each, or does not need them.

## 4. License obligations

MIT requires that the copyright and permission notice travel with substantial portions. Ave meets this in two places:

1. `LICENSE` lists the project under Third-Party Attributions and links here.
2. Every source file in section 2 carries this header. The test file has an equivalent comment scoped to its one `describe` block.

```typescript
/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/<path>.py
 * Copyright (c) 2025 OpenHarness Contributors
 */
```

`src/tools/shell-tools.ts` scopes the header to "the bash tool sections below".

When changing these files:

- Keep the header while any adapted portion remains. If the adapted code is fully replaced, remove the header and update sections 2 and 3 together.
- When a borrowed pattern moves to another file, move the header with it and update the table.
- A new port needs the same header and a row here. The `LICENSE` summary must keep naming the directories that hold attributed files (`src/tools/`, `src/core/`, `src/permissions/`, `src/sandbox/`).

To check the inventory:

```bash
grep -rln "OpenHarness" src
```

## Related

- [`LICENSE`](../../LICENSE)
- [Sandbox isolation](../research/sandbox-isolation.md)
- [Permission policy design](../architecture/permission-policy-design.md)
- [Blueprints index](./README.md)
