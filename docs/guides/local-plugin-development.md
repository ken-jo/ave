# Local Extension Development

Status: Active. Describes the development-build loop as the code implements it
today.

This page covers building an extension and running it in a development build
without a marketplace. The manifest, HostApi and tool rules live in the
[Extension Development Guide](./plugin-development.md); this page does not
repeat them.

## Choosing A Loop

| | Without a marketplace | With a marketplace |
|--|--|--|
| Development build (`bun run dev`) | This page: install a build folder from Settings | [Testing A Marketplace Locally](./local-marketplace-testing.md): serve a git repository over loopback |
| Packaged build | Not supported | [Publishing To A Git Marketplace](./marketplace-publishing.md) |

Use this page to try a build quickly. Use a local marketplace when you need to
exercise the real install, update and artifact-pinning path.

## Start An Extension

New extensions start from `templates/extension/` in the official marketplace
monorepo `ken-jo/agent-marketplace` and live at `plugins/<name>/source/`
there. That repository's README owns the build and publishing commands.

The extension's `contract/` directory holds the public contract and schemas
vendored from an app release tag; see [Manifest Basics](./plugin-development.md#manifest-basics)
and the [Extension Version Quick Reference](./plugin-version-quickref.md).

Before installing, run the validator from this repository against the build
folder (see [Testing Checklist](./plugin-development.md#testing-checklist)):

```bash
bun run plugin:validate <extension build folder>
```

## Install A Build Folder

1. Build the extension so the folder contains `plugin.json` and its `dist/`
   output.
2. Start the app in development mode from this repository:

   ```bash
   bun run dev
   ```

   `scripts/run-electron-dev.mjs` always sets `AVE_DEV=1`.
3. Open Settings > Plugin Config. The Developer tools panel at the bottom
   shows **Install from local folder** only when the renderer sees
   `AVE_DEV=1` (`src/ui/renderer/tabs/PluginConfigTab.tsx`).
4. Pick the build folder. The running host installs it and starts it; there is
   nothing to restart.

What the host does (`installLocal` in `src/plugins/marketplace.ts`, IPC handler
in `src/ipc/domains/plugins.ts`):

- Refuses unless development mode is unlocked (`isDevModeUnlocked` in
  `src/boot/dev-flags.ts`), which is never true in a packaged build.
- Requires a `plugin.json` with a non-empty `id` matching
  `^[a-zA-Z0-9._-]+$` and a non-empty `version`.
- Refuses an extension that declares a `process` entry
  (`process-entry-requires-pinned-artifact`): those run only from a pinned
  marketplace release or archive. See [`entry` or `process`](./plugin-development.md#entry-or-process).
- Copies the folder into a staging directory under the plugins root, skipping
  `.git` and `node_modules/electron`, `node_modules/@electron` and
  `node_modules/.bin` (`src/plugins/sideload-filter.ts`). Other dependencies
  are copied and imported from the installed copy.
- Writes an install receipt over the staged files, then activates the new
  generation through the same staged transaction a marketplace install uses,
  and records the registry entry with `installSource: "local-dev"`.

Installing the same id again replaces the previous local install. A local
install never qualifies for host secret grants
([Marketplace And Installation](./plugin-development.md#marketplace-and-installation)).

The load gates still apply: `requires.hostProtocol` must name a protocol this
app serves, and `requires.minAppVersion`, when present, must not exceed the
running app version. `minAppVersion` is optional for a local install but
required for any marketplace install.

## The Plugins Root

Every install, local or marketplace, lives under one root:
`~/.ave/plugins/` (`%USERPROFILE%\.ave\plugins\` on Windows), resolved by
`resolvePluginPaths` in `src/plugins/plugin-paths.ts`. The root is
`<AVE_HOME>/plugins`, where `AVE_HOME` defaults to `~/.ave`
(`src/shared/ave-home.ts`); there is no plugins-specific variable, and tests
inject a `pluginsRoot` instead. `AVE_USER_DATA_DIR` changes the app profile
directory only, not the plugins root.

The registry (`~/.ave/plugins/registry.json`) is host-owned state. Do not edit
it. At boot the runtime ignores any entry whose manifest path is outside the
plugins root and logs
`ignoring untrusted registry manifest path for <id>: <path>`
(`isTrustedRegistryManifestPath` in `src/plugins/registry-manifest-trust.ts`,
called from `src/plugins/runtime/index.ts`). A sibling checkout, or a symlink from the
plugins root to one, is therefore never loaded; install the build folder
instead.

To inspect what is installed:

```bash
bun run plugins:list
```

`scripts/plugins-cli.ts` is read-only. It has no install, remove, enable or
disable command; it points you to the Settings flow.

## Reload

After rebuilding, install the build folder again from Settings. That is the
supported loop: it re-copies the folder, writes a fresh receipt and restarts
the extension.

`AVE_DEV_RELOAD=1` also starts a watcher (`src/plugins/dev-watcher.ts`). It
watches the directory of each loaded JavaScript extension's resolved entry, in
the installed copy under the plugins root, not your source checkout. On a
`.js`, `.mjs` or `.cjs` change it waits 500 ms and calls
`PluginRuntime.reloadPlugin`, which restarts only that extension and logs
`[plugin-dev-watcher] reloading <id>` and `[plugin-dev-watcher] reloaded <id>`.
`process` extensions are not watched. A change to `plugin.json` needs a fresh
install.

```bash
AVE_DEV_RELOAD=1 bun run dev
```

## Launcher Flags

| Variable | Effect |
|--|--|
| `AVE_DEV=1` | Development mode and the Developer tools panel. Set by `bun run dev`; not set by `bun run start`. |
| `AVE_DEV_RELOAD=1` | Unlocks development mode in the main process and starts the reload watcher. It does not show the Developer tools panel on its own. |
| `AVE_DEV_CONSOLE=0` | Do not open developer tools automatically. `bun run start` defaults to `0`. |

Source runs never register `ave://`. A macOS dev clone installed before this change still has `ave` injected into its vendored `node_modules/electron/dist/Electron.app` Info.plist, so LaunchServices may still send `ave://` links there: launch the packaged Ave once, or run `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u <clone>/node_modules/electron/dist/Electron.app`.

In a packaged build every development-only variable is scrubbed, and the
names that were set are logged as an error at boot (`shouldWarnPackagedFlagsIgnored`,
`src/boot/dev-flags.ts`; inventory in `src/shared/development-env-policy.ts`).
No flag bypasses marketplace artifact hash checks, install receipt
verification or entry-path containment.

## Packaged Builds

A packaged build has no side-load path. The Developer tools panel is hidden,
`installLocal` refuses, and registry edits are not supported. Ship through a
git marketplace.

## Troubleshooting

| Symptom | Cause |
|--|--|
| Install from local folder is missing | The app was not started with `AVE_DEV=1`, or it is a packaged build. |
| `process-entry-requires-pinned-artifact` | The manifest declares `process`; install it from a marketplace that pins a release or archive. |
| `ignoring untrusted registry manifest path` at boot | A registry entry points outside the plugins root. Reinstall from Settings. |
| `[manifest:<id>] schema validation failed (<path>): ...` | `plugin.json` does not match `schemas/plugin-manifest.schema.json`. Run the validator. |
| Refused with `incompatible-host-protocol` | `requires.hostProtocol` is missing or not served by this app. |
| Refused with `incompatible-app-version` | `requires.minAppVersion` is newer than the running app. |
| The watcher never reloads | `AVE_DEV_RELOAD=1` is not set, or you rebuilt the source checkout; the watcher follows the installed copy. Reinstall the folder. |

## Related

- [Extension Development Guide](./plugin-development.md)
- [Extension Version Quick Reference](./plugin-version-quickref.md)
- [Testing A Marketplace Locally](./local-marketplace-testing.md)
- [Publishing To A Git Marketplace](./marketplace-publishing.md)
- [Extension Deployment Model](../architecture/plugin-deployment-model.md)
- [Windows setup](./windows-setup.md)
