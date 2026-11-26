# All-Profile Windows Toast Artifact Lifecycle (per-machine installs)

Status: Proposed

This ADR records the unpackaged release limit and the supported package
identity design. Adoption is subject to the existing release packaging decision.

## What This Page Owns

This page owns the decision for how Ave toast/notification artifacts
(per-user Start Menu shortcut + per-user toast-activator CLSID) are created and
removed across ALL Windows profiles for a per-machine (perMachine NSIS) install.
It is the first review surface for that decision. Source files and tests are
authoritative when this prose and the implementation disagree.

## Problem

Ave ships a per-machine NSIS installer (`oneClick:true` + `perMachine:true`;
all-users Program Files, HKLM ownership - `build/installer.nsh:158-163`). The
app files and protocol registration are machine-scoped, but the Windows toast
notification surface is per-user by design:

- On first launch, the main process pins a product-owned identity and toast
  activator CLSID: `app.setAppUserModelId("ai.agent-connector.ave")` and, on Windows,
  `app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID)` where the CLSID is
  `{62FD3EFB-B3D2-4235-9402-6979F52C0286}`
  (`src/main/early-boot-env.ts`). Unpackaged runs use
  `ai.agent-connector.ave.dev` and their own CLSID, so on a clean machine a
  development run never re-points the installed app's activator at a bare
  `electron.exe`. Electron reuses the CLSID stored in an existing
  `Programs\Electron.lnk` over the one the app sets, so a machine where an
  earlier dev run already wrote that shortcut with the product CLSID would keep
  the hijack. Before setting the dev CLSID, an unpackaged run removes that
  shortcut only when it carries the product CLSID, and stops with an error when
  it cannot read or remove it rather than adopting the product CLSID.
- The unpackaged runtime provisions two per-user artifacts the first time a
  notification presenter initializes, for EACH Windows user who runs the app:
  1. a Start Menu shortcut in that user's Programs known folder
     (`Environment.SpecialFolder.Programs`), carrying the AppUserModelID and the
     ToastActivatorCLSID (`build/uninstall-windows-notification-artifacts.ps1:388-392`);
  2. a per-user COM activator registration under
     `HKCU\Software\Classes\CLSID\{clsid}\LocalServer32` with root default
     `Electron Notification Activator`, `CustomActivator` DWord = 1, and
     `LocalServer32` default pointing at the installed executable
     (`build/uninstall-windows-notification-artifacts.ps1:186-223`).

**Release limit — per-profile toast registration.** An unpackaged NSIS build
always writes HKCU per user who runs Ave, so uninstall can clean only the
current user's entries. When the notification presenter initializes, the
unpackaged branch runs
`if (!is_packaged) { EnsureShortcut(); EnsureCLSIDRegistry(); }`.
[v45.3.4 `shell/browser/notifications/win/windows_toast_activator.cc:310–321`](https://github.com/electron/electron/blob/v45.3.4/shell/browser/notifications/win/windows_toast_activator.cc#L310-L321)

Genuine uninstall invokes `un.aveCleanupCurrentUserNotificationArtifacts`
(`build/installer.nsh:335-382`, dispatched at `:425-434`), which shells the
per-user PowerShell cleanup for the invoking identity - in the normal
alternate-admin UAC path it runs inside electron-builder's retained OUTER user
process via `UAC_AsUser_Call` (`build/installer.nsh:425-426`). The cleanup
targets the invoking user's Programs folder and HKCU hive only
(`build/uninstall-windows-notification-artifacts.ps1:241-256,332-356,388-392`).

Result: if user A installs and runs the app and user B also runs it, both
profiles get a shortcut + HKCU CLSID. A genuine uninstall performed by A removes
only A's pair. B's shortcut and HKCU CLSID survive as orphaned residue.

## Current behavior evidence (what the code actually does)

Two points sharpen the picture beyond the issue text:

- The cleanup is provably ownership-scoped, not a broad delete. It fails closed
  and preserves anything that is not byte-exact Ave: a same-target
  partial-owned shortcut is classified `foreign-preserved` and survives
  byte-for-byte (`build/uninstall-windows-notification-artifacts.ps1:405-420`,
  and the round-trip is asserted on a real `.lnk` in
  `test/scripts/smoke-windows-nsis-installer.test.ts:409-614`). Any per-value
  type/data mismatch on the CLSID keys aborts the delete
  (`...ps1:178-228,278-282`). So extending to other profiles inherits a strict,
  audited ownership test - the risk is which hives/folders we are allowed to
  reach, not the matching logic.
- Two independent updater guards already exist and MUST be preserved. Genuine
  uninstall vs. updater uninstall is branched by BOTH electron-builder's
  compile-time `${isUpdated}` and an explicit `--updated` GetOptions probe, in
  `customUnInstall` (`build/installer.nsh:402-410`, skipping to
  `ave_skip_genuine_uninstall`) and again in `customRemoveFiles`
  (`build/installer.nsh:530,601-611`). The notification cleanup runs only on the
  genuine path, AFTER those guards. Any all-profile design must sit behind the
  same guards or it will strip activation during an auto-update.
- The current single-user smoke (`test/scripts/smoke-windows-nsis-installer.test.ts`)
  drives one user: install `/allusers`, assert exact protocol + owned-shortcut
  provenance, uninstall, then assert removal
  (`assertRuntimeNotificationArtifactsRemoved`, e.g. lines 1266+). There is no
  second-profile coverage today; the two-user test is net-new work.

## Hard constraints

Any accepted design MUST satisfy all of the following:

1. No arbitrary enumeration or deletion across other users' profile hives. We
   must not load foreign `NTUSER.DAT` hives and sweep them, nor delete by
   guessing per-user paths. (This is the core reason the naive "just clean every
   profile" approach is rejected.)
2. Never touch foreign (non-Ave) values or files. The exact-ownership contract
   requires a byte-exact match on shortcut target, working dir, empty args,
   description, AUMID, and valid toast CLSID, plus exact type/data on the CLSID keys
   (`...ps1:124-166,178-228`).
3. Must work for a standard-user uninstall performed with alternate admin
   credentials - the common enterprise case. The current design already handles
   this by splitting elevated machine actions from the outer-user notification
   cleanup (`build/installer.nsh:425-429`); an all-profile design must not
   assume the uninstalling identity equals the profile that owns the residue.
4. macOS and Linux runtime and packaging paths untouched
   (`build/installer.nsh` is Windows-only; the CLSID write is guarded by
   `process.platform === "win32"` at `src/main/early-boot-env.ts:75`).
5. Must NOT regress the merged updater-path preservation. Both `${isUpdated}`
   and the explicit `--updated` guard must continue to short-circuit BEFORE any
   notification/CLSID teardown (`build/installer.nsh:402-410,530,601-611`).
6. Must NOT regress the shipped invoking-user cleanup. All-profile
   coverage is additive; the exact invoking-user delete/reinstall path stays
   green.
7. Must not brick install/uninstall. Notification provisioning/cleanup is
   non-fatal-by-posture elsewhere (e.g. the sandbox provisioning at
   `build/installer.nsh:173-175`); an all-profile mechanism should not turn a
   cosmetic residue into an install/uninstall Abort for foreign-profile edge
   cases it cannot safely reason about.

## Candidate designs

### Option A - Machine-owned toast registration

An all-users Start Menu shortcut and an HKLM activator entry would add a
machine-wide registration. The unpackaged runtime would still provision the
shortcut and HKCU registration for each user. The AUMID and CLSID setters
select identifiers only, so machine-wide entries alone leave the release limit
in place.

### MSIX/AppX package identity with external location

A signed package with external location gives the NSIS-installed executable
Windows package identity. The runtime skips both per-user provisioning calls
and still registers the activator class for runtime COM activation. Embed the
matching identity in the executable manifest and declare the fixed toast
activator GUID in both the COM server and toast activation extensions of the
package manifest. NSIS stages the signed package against the installed
executable's directory and provisions it for all users. Preserve package
registration across updates and remove it for all users on genuine uninstall.
This route requires a trusted package signature and Windows build 19041 or
later.
[External-location package deployment](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps#per-machine-packagemanager)
[Toast manifest extensions](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/app-notifications-quickstart#update-the-app-package-manifest-file)

## Decision

Keep the per-profile toast registration limit for the current unpackaged NSIS
release. Its genuine-uninstall cleanup remains scoped to the current user.
Package identity with external location is the supported fix for the two
runtime-created artifacts. Adoption belongs to the existing
[MSIX/AppX packaging decision](../references/production-release-checklist.md#msixappx-packaging-decision),
which owns signing, updating, and distribution requirements.

## Migration and rollback outline

The packaging decision must account for legacy artifacts. Package identity
prevents new runtime-created pairs. Existing pairs need exact-ownership cleanup
from within each affected profile. Package teardown on genuine uninstall must
respect the existing `${isUpdated}` and `--updated` guards
(`build/installer.nsh:402-410,601-611`).

Rollback to an unpackaged build must remove the identity package and restore
the unpackaged executable and updater path. The per-profile release limit then
applies again. Release-level rollback follows the
[existing procedure](../references/production-release-checklist.md#rollback-procedure).

## Acceptance mapping

Use the existing [all-profile toast cleanup gate](../references/production-release-checklist.md#all-profile-toast-cleanup)
to verify clean installation, migration, genuine uninstall, and updater
preservation with two Windows users. For a candidate with package identity,
verify identity and warm and cold toast activation in both profiles, including
after updater relaunch. Verify that genuine uninstall removes the package
registration for both users and that foreign artifacts survive unchanged.

## Implementation Anchors

- `build/installer.nsh` (`customUnInstall`, `un.aveCleanupCurrentUserNotificationArtifacts`, updater guards)
- `build/uninstall-windows-notification-artifacts.ps1` (exact-ownership cleanup contract)
- `src/main/early-boot-env.ts:25-77` (AUMID + pinned toast CLSID)
- `test/scripts/smoke-windows-nsis-installer.test.ts` (single-user smoke; two-user test to be added)
- [MSIX/AppX packaging decision](../references/production-release-checklist.md#msixappx-packaging-decision)

## Related Entry Points

- [Architecture](./README.md)
- [Production Release Checklist](../references/production-release-checklist.md)
