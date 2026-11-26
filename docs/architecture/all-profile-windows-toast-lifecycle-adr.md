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

Ave ships a per-machine NSIS installer. `build.nsis` in `package.json` sets
`oneClick` and `perMachine` to `true`, and `customInstall` in
`build/installer.nsh` registers the protocol in HKLM. Application files go
under Program Files, while toast notification artifacts belong to each user:

- On first launch, the main process pins a product-owned identity and toast
  activator CLSID: `app.setAppUserModelId("ai.agent-connector.ave")` and, on Windows,
  `app.setToastActivatorCLSID(WINDOWS_TOAST_ACTIVATOR_CLSID)` where the CLSID is
  `{62FD3EFB-B3D2-4235-9402-6979F52C0286}`
  (`runEarlyBootEnv` in `src/main/early-boot-env.ts`). In development runs, Ave
  uses `ai.agent-connector.ave.dev` and a distinct CLSID, so on a clean machine a
  development run never re-points the installed app's activator at a bare
  `electron.exe`. Electron reuses the CLSID stored in an existing
  `Programs\Electron.lnk` over the one the app sets, so a machine where an
  earlier dev run already wrote that shortcut with the product CLSID would keep
  the hijack. Before setting the dev CLSID, a development run removes that
  shortcut only when it carries the product CLSID, and stops with an error when
  it cannot read or remove it rather than adopting the product CLSID.
- The unpackaged runtime provisions two per-user artifacts the first time a
  notification presenter initializes, for EACH Windows user who runs the app:
  1. a Start Menu shortcut in that user's Programs known folder
     (`Environment.SpecialFolder.Programs`), carrying the AppUserModelID and the
     ToastActivatorCLSID (see the `Environment.GetFolderPath` call in
     `build/uninstall-windows-notification-artifacts.ps1`);
  2. a per-user COM activator registration under
     `HKCU\Software\Classes\CLSID\{clsid}\LocalServer32` with root default
     `Electron Notification Activator`, `CustomActivator` DWord = 1, and
     `LocalServer32` default pointing at the installed executable
     (see `Test-ExactToastRegistration` and `Remove-ExactToastRegistration` in
     `build/uninstall-windows-notification-artifacts.ps1`).

**Release limit — per-profile toast registration.** An unpackaged NSIS build
always writes HKCU per user who runs Ave, so uninstall can only clean the
current user's entries. When the notification presenter initializes, the
unpackaged branch runs
`if (!is_packaged) { EnsureShortcut(); EnsureCLSIDRegistry(); }`.
[v45.3.4 `shell/browser/notifications/win/windows_toast_activator.cc:310–321`](https://github.com/electron/electron/blob/v45.3.4/shell/browser/notifications/win/windows_toast_activator.cc#L310-L321)

In `build/installer.nsh`, `customUnInstall` dispatches
`un.aveCleanupCurrentUserNotificationArtifacts`. Under normal alternate-admin
UAC, `UAC_AsUser_Call` runs cleanup in the retained outer user process.
`build/uninstall-windows-notification-artifacts.ps1` scopes cleanup to that
user's Programs folder and HKCU through `Environment.GetFolderPath` and
`ToastRegistryKey.OpenCurrentUser`.

Result: if user A installs and runs the app and user B also runs it, both
profiles get a shortcut + HKCU CLSID. A genuine uninstall performed by A removes
only A's pair. B's shortcut and HKCU CLSID survive as orphaned residue.

## Current behavior evidence (what the code actually does)

Two points sharpen the picture beyond the issue text:

- The cleanup is provably ownership-scoped, not a broad delete. It fails closed
  and preserves anything that is not byte-exact Ave: a same-target
  partial-owned shortcut is classified `foreign-preserved` and survives
  byte-for-byte. See `Get-ShortcutOwnershipMismatches` in
  `build/uninstall-windows-notification-artifacts.ps1` and the
  “preserves a real same-target partial-owned shortcut without aborting” case
  in `test/scripts/smoke-windows-nsis-installer.test.ts`.
  `Remove-OwnedToastRegistration` can recover any exact typed slot at the pinned
  product CLSID even when the shortcut is gone. A foreign occupant of one of
  the three slots blocks that removal. Legacy CLSIDs require a verified shortcut
  and a complete tuple. Cleanup takes a per-user mutex and fails if it finds a
  shortcut left in quarantine by a prior invocation.
  Cleanup verifies that the invoking user has no running Ave process before
  mutation and again before final verification. It disposes of the quarantined
  shortcut only after two consecutive scans of every candidate CLSID in every
  registry view show identical slot state and no owned value. A read failure
  or an observed change retains the shortcut evidence. The scans are
  observational. An external writer can still recreate a slot after the last
  scan. A write that leaves both observations identical can go undetected,
  including one after the last read of its slot.
- `customUnInstall` and `customRemoveFiles` in `build/installer.nsh` distinguish
  genuine uninstall from updater uninstall with the compile-time `${isUpdated}`
  check and an explicit `--updated` GetOptions probe. Notification cleanup runs
  on the genuine path after those checks. Apply the same guards to all-profile
  cleanup to preserve activation during updates.
- The single-user smoke in `scripts/smoke-windows-nsis-installer.mjs` installs
  with `/allusers`, verifies exact protocol and owned-shortcut provenance,
  uninstalls, then checks the result in
  `assertRuntimeNotificationArtifactsRemoved`. Second-profile coverage requires
  the two-user acceptance gate.

## Hard constraints

Any accepted design MUST satisfy all of the following:

1. No arbitrary enumeration or deletion across other users' profile hives. We
   must not load foreign `NTUSER.DAT` hives and sweep them, nor delete by
   guessing per-user paths. (This is the core reason the naive "just clean every
   profile" approach is rejected.)
2. Never touch foreign (non-Ave) values or files. The exact-ownership contract
   requires a byte-exact match on shortcut target, working dir, empty args,
   description, AUMID, and valid toast CLSID, plus exact type/data on the CLSID keys
   (`Get-ShortcutOwnershipMismatches` and `Get-OwnedToastRegistrationValueCount`
   in `build/uninstall-windows-notification-artifacts.ps1`).
3. Must work for a standard-user uninstall performed with alternate admin
   credentials - the common enterprise case. The current design already handles
   this by splitting elevated machine actions from the outer-user notification
   cleanup (`customUnInstall` in `build/installer.nsh`). An all-profile design
   must account for residue owned by users other than the one uninstalling.
4. macOS and Linux runtime and packaging paths untouched
   (`build/installer.nsh` is Windows-only; the CLSID write is guarded by
   `process.platform === "win32"` in `runEarlyBootEnv` in
   `src/main/early-boot-env.ts`).
5. Must NOT regress the merged updater-path preservation. Both `${isUpdated}`
   and the explicit `--updated` guard must continue to short-circuit BEFORE any
   notification/CLSID teardown (`customUnInstall` in `build/installer.nsh`).
6. Must NOT regress the shipped invoking-user cleanup. All-profile
   coverage is additive; the exact invoking-user delete/reinstall path stays
   green.
7. Keep install and uninstall usable when cosmetic residue in a foreign profile
   lacks enough evidence for safe cleanup. For an example of recoverable
   provisioning failures, see `customInstall` in `build/installer.nsh`.

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
(`customUnInstall` and `customRemoveFiles` in `build/installer.nsh`).

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
- `src/main/early-boot-env.ts` (AUMID and pinned toast CLSID in `runEarlyBootEnv`)
- `test/scripts/smoke-windows-nsis-installer.test.ts` (single-user smoke; two-user test to be added)
- [MSIX/AppX packaging decision](../references/production-release-checklist.md#msixappx-packaging-decision)

## Related Entry Points

- [Architecture](./README.md)
- [Production Release Checklist](../references/production-release-checklist.md)
