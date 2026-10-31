# Testing A Marketplace Locally

Status: **Active** (2026-09-25). Replaces the local server-marketplace loop,
removed with the server stack by the switch to the
[multi-source git marketplace](../blueprints/multi-source-git-marketplace.md).

A marketplace is a git repository, so testing one locally means serving a
repository to a development build and adding it the way a user would. For the
file formats, see [Publishing To A Git Marketplace](./marketplace-publishing.md).

## What A Development Build Allows

The app reaches a marketplace over git only: https, ssh, or — in an unpackaged
build started with `AVE_DEV=1` — plain HTTP on loopback (`127.0.0.1`,
`localhost`, `::1`). `bun run dev` sets `AVE_DEV=1`. A packaged build refuses
plain HTTP to loopback, and every build refuses the `file://` protocol, so a
local directory is served over loopback rather than added by path.

The git the app runs must be 2.45.1 or newer; Settings → Marketplace offers to
install a managed copy when the system git is older or missing.

## Serve A Repository

Serve the repository through `git http-backend` (the smart HTTP protocol). The
app fetches with partial-clone filters and by object id, so enable both on the
served repository:

```bash
git clone --bare ./my-marketplace /tmp/served/my-marketplace
git -C /tmp/served/my-marketplace config uploadpack.allowFilter true
git -C /tmp/served/my-marketplace config uploadpack.allowAnySHA1InWant true
```

Any CGI-capable server can run `git http-backend` with `GIT_PROJECT_ROOT=/tmp/served`
and `GIT_HTTP_EXPORT_ALL=1`. The end-to-end test's fixture,
`src/marketplace/__tests__/fixtures/git-http-server.ts`, is a small Node server
that does exactly this and can be copied. Push to the bare repository (or
commit in a clone whose remote it is) to publish a new version.

## Add And Install

1. Start the app with `bun run dev`, preferably with an isolated `AVE_HOME`
   so test installs never touch `~/.ave`.
2. Settings → Marketplace → Add → Add marketplace, and enter
   `http://127.0.0.1:<port>/my-marketplace`. The preview lists the packages
   per kind and any the app skipped, with the reason.
3. Install from the catalog. Extensions show the rung that delivered them; MCP
   servers report a connection warning when they were saved but did not
   connect.
4. Publish a new version, press Refresh in Sources, and update from the
   catalog to see the update review.

To try one package without an index, use Add → Install from Git URL with the
repository, or a folder in it, that holds the package. The app looks there for
`ave-package.json`, then `plugin.json`, `SKILL.md`, `AGENTS.md` or
`server.json`.

## MCP Servers

MCP governance applies to marketplace installs: a server the governance policy
(`$AVE_HOME/governance/mcp-policy.json`) does not approve is refused with
`PACKAGE_POLICY_BLOCKED`. Add an approval for the server's id, transport and
exact command to the test home's policy before installing it.

## The End-To-End Test

`test/e2e/ui/git-marketplace-lifecycle.spec.ts` is the reference: it serves a
fixture marketplace with one package of every kind, adds it through the
Marketplace tab, installs, publishes 1.1.0 and updates each package, removes
the source and uninstalls what the source left. It needs `bun run build`
first:

```bash
bun run build
bun run test:ui-e2e test/e2e/ui/git-marketplace-lifecycle.spec.ts
```

## Implementation Anchors

- `src/marketplace/net/network-gate.ts` — which remotes a build may reach
- `src/ipc/domains/git-marketplace.ts` — the service the tab talks to
- `src/marketplace/__tests__/fixtures/git-http-server.ts` — a loopback git server
- `test/e2e/ui/git-marketplace-lifecycle.spec.ts` — the end-to-end run
