# Windows Setup

Status: Active. Covers running Ave from source on Windows 10 or 11.

The general setup is in [Getting started](./getting-started.md). This page covers only what differs on Windows. `bun run start` applies the Windows launch defaults itself, so a clean checkout should start without extra configuration.

## 1. Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | `>=22.12` (from `package.json` `engines`) | `node -v` |
| Bun | Current release | `bun -v` |
| Git | Any recent release | `git --version` |

Both Bun and Node.js must be on `PATH`: Bun is the package manager, and the launcher and several build scripts run the system `node`. PowerShell, Windows Terminal and cmd all work.

Optional, only for background shell commands (see section 5): C++ build tools that `vswhere` can find.

## 2. Install and run from source

```powershell
git clone <repo-url>
cd ave
bun install
bun run start
```

`bun run start` runs `bun run build` and then `node scripts/run-electron.mjs dist/src/main/main.js`.

CI installs with `bun install --frozen-lockfile`. If a local build works but CI reports a lockfile mismatch, run the same command locally and commit the resulting `bun.lock` change.

Plugins are not taken from sibling checkouts. Install them from a marketplace, or for a local build use Settings, Plugin Config, Developer Tools, "Install from local folder", and select the folder that contains `plugin.json`. See [Local plugin development](./local-plugin-development.md).

Success: the log shows `boot: ready (N tools, N plugins, N mcp)` and the window opens.

With the OS sandbox on, agent shell commands run in Microsoft Execution Containers when the launcher is present. Installers include it; a source checkout stages it once with `node scripts/fetch-mxc.mjs --arch x64` (or `arm64`). Without it, Settings → Permissions reports `binary-missing` and shells use the approved host route. See the architecture document, "Windows agent shells in Microsoft Execution Containers".

## 3. What the Windows launcher sets

`scripts/run-electron.mjs` (with `scripts/lib/electron-launch-options.mjs` and `scripts/electron-flags.mjs`) applies these on `win32`:

| Setting | Default | Purpose |
|---|---|---|
| `--disable-gpu`, `--disable-software-rasterizer`, `--disable-gpu-compositing`, `--no-sandbox` | Added unless `AVE_KEEP_GPU=1` | Avoids the "GPU process isn't usable" crash on machines with restricted GPU drivers. |
| `--user-data-dir` | `%APPDATA%\Electron-Ave-Run`, or `AVE_USER_DATA_DIR` | Separate profile for source runs. |
| `PYTHONIOENCODING`, `PYTHONUTF8`, `LANG`, `LC_ALL` | `utf-8`, `1`, `en_US.UTF-8` | UTF-8 output from Python and other children. |
| `chcp 65001` | Electron starts through `cmd.exe` in the same console | Console output stays UTF-8. |

A source run never registers itself as the `ave://` handler, so it cannot take
an installed Ave's deep links in HKCU. Only a packaged app on its real profile
registers; unpackaged, E2E, `AVE_HOME`-relocated and `--user-data-dir` launches
skip and log the reason (`decideAveProtocolClientRegistration`,
`src/main/ave-protocol-registration.ts`).

Overrides:

| Variable | Effect |
|---|---|
| `AVE_KEEP_GPU=1` | Skip the GPU and Chromium-sandbox flags (machines with a working GPU). |
| `AVE_EXTRA_ELECTRON_FLAGS="--a --b"` | Append flags while keeping the defaults. |
| `AVE_USER_DATA_DIR` | Use another profile directory. |
| `AVE_DEBUG=1` | Print the final args to stderr (`[run-electron] args=...`). |

For one session:

```powershell
$env:AVE_DEBUG = "1"
bun run start
```

## 4. Troubleshooting

### GPU crash: "GPU process isn't usable. Goodbye!"

Make sure `AVE_KEEP_GPU` is not set, so the safe flags are applied:

```powershell
Remove-Item Env:\AVE_KEEP_GPU -ErrorAction SilentlyContinue
bun run start
```

If it still crashes, add flags with `AVE_EXTRA_ELECTRON_FLAGS` (for example `--disable-webgl`) and confirm them with `AVE_DEBUG=1`.

### Garbled log output

Windows PowerShell 5.1 caches `[Console]::OutputEncoding` at session start, so `chcp 65001` alone may not help. In the current session:

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001
bun run start
```

To make it permanent, add the first two lines and `chcp 65001 | Out-Null` to `$PROFILE`. PowerShell 7 and Windows Terminal default to UTF-8.

### Clean reinstall leaves directories behind

`Remove-Item -Recurse` in PowerShell 5.x can fail on locked trees. Use cmd instead:

```powershell
cmd /c "if exist node_modules rmdir /s /q node_modules"
cmd /c "if exist dist rmdir /s /q dist"
bun install
```

### Plugin build changes do not appear

The local install copies the build folder, so the app runs the installed copy, not your checkout. After rebuilding, install the folder again through "Install from local folder". This copies it again and restarts the extension. See [Local plugin development](./local-plugin-development.md#reload).

## 5. Windows-specific features

- **Background shell commands** run under a Windows job object launched by `resources/windows-job/<arch>/ave-job.exe` (`src/main/windows-job-launcher.ts`). The executable is git-ignored, not checked in. Build it with `bun run build:windows-job`, which needs the C++ build tools. Without it, a background shell command fails with "Windows job launcher is missing". Foreground commands are unaffected.
- **OS tool sandbox** is off by default. When turned on in Settings, Permissions, it needs a one-time administrator setup. On Windows it confines filesystem and network access, not processes; see [Sandbox isolation](../research/sandbox-isolation.md). If live sandbox tests skip with an access-denied warning, follow the sandbox troubleshooting steps in the [README](../../README.md).

## 6. Path-sensitive validation

Windows path spelling (drive letters, `\` separators, case folding, file locking) is exercised by the Windows CI job in `.github/workflows/ci.yml`. After changing permissions, paths, storage or shell code, run the relevant part of that job locally:

```powershell
bun run check:plugin-host-protocol-schema
bun run test -- src/permissions/__tests__/allowed-directories.test.ts src/permissions/__tests__/sensitive-paths-canonicalize.test.ts src/shared/__tests__/ave-home.test.ts src/lib/__tests__/atomic-file.test.ts src/lib/__tests__/with-file-lock.test.ts src/tools/__tests__/bash-dialect.test.ts src/tools/__tests__/shell-windows-partial-plan-b.test.ts src/permissions/__tests__/windows-sandbox-logic.test.ts src/permissions/__tests__/asrt-windows-support.test.ts src/main/__tests__/windows-job-launcher.test.ts
```

The CI job is the full list. It also builds the native helpers (`scripts/build-windows-job.ps1`, then `node scripts/test-windows-job.mjs` and `node scripts/test-windows-path-kind.mjs`).

Use `bun run test`, not `bun test`. The suite runs under Vitest through `scripts/run-vitest-under-electron.mjs`.

Checklist after a first run:

- Logs are readable (no mojibake).
- `boot: ready (...)` appears and the window opens.
- DevTools (`Ctrl+Shift+I`) shows no errors in the console.
- No GPU crash on launch.

## Related

- [Getting started](./getting-started.md)
- [Local plugin development](./local-plugin-development.md)
- [Sandbox isolation](../research/sandbox-isolation.md)
