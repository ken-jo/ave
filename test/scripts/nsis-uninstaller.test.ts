import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../src/__tests__/test-helpers.js";

const hook = readRepoFile("build/installer.nsh");
const initialization = readRepoFile("build/uninstaller-init.nsh");
const templateRoot = resolve("node_modules/app-builder-lib/templates/nsis");
const readTemplate = (name: string) => readFileSync(resolve(templateRoot, name), "utf8");

function allProfileToastGate() {
  return readRepoFile("docs/references/production-release-checklist.md")
    .split("### All-profile toast cleanup\n")[1]?.split("\n##")[0]
    ?.replace(/\s+/g, " ");
}

const cleanupFunction = "un.aveCleanupCurrentUserNotificationArtifacts";
const skipLabel = "ave_skip_genuine_uninstall:";
const cleanupDispatch = [
  `  \${if} \${UAC_IsInnerInstance}`,
  `    !insertmacro UAC_AsUser_Call Function ${cleanupFunction} \${UAC_SYNCREGISTERS}`,
  `  \${else}`,
  `    Call ${cleanupFunction}`,
  `  \${endif}`,
].join("\n");

function expectGuardedToastCleanup(source: string) {
  const uninstall = source.split("!macro customUnInstall\n")[1].split("!macroend")[0];
  const updaterGuards = [
    /\$\{if\} \$\{isUpdated\}\s+Goto ave_skip_genuine_uninstall\s+\$\{endif\}/,
    /\$\{GetOptions\} \$R0 "--updated" \$R2\s+\$\{ifNot\} \$\{Errors\}\s+Goto ave_skip_genuine_uninstall\s+\$\{endif\}/,
  ];
  const dispatchIndex = uninstall.indexOf(cleanupDispatch);
  expect(dispatchIndex, "the guarded two-branch cleanup dispatch must exist").toBeGreaterThan(-1);
  for (const guard of updaterGuards) {
    const match = uninstall.match(guard);
    expect(match).not.toBeNull();
    expect((match?.index ?? Infinity) + (match?.[0].length ?? 0)).toBeLessThan(dispatchIndex);
  }
  expect(uninstall.split(skipLabel)).toHaveLength(2);
  const skipIndex = uninstall.indexOf(skipLabel);
  const failureCheck = uninstall.match(
    /DetailPrint "\$R5"\s+\$\{if\} \$R4 != 0\s+SetErrorLevel 1\s+Abort "[^"\n]+"\s+\$\{endif\}/,
  );
  expect(failureCheck).not.toBeNull();
  const failureIndex = failureCheck?.index ?? -1;
  expect(failureIndex).toBeGreaterThan(dispatchIndex);
  expect(skipIndex, "the updater jump must clear the entire cleanup block").toBeGreaterThan(
    failureIndex + (failureCheck?.[0].length ?? 0),
  );
  expect(
    uninstall.replace(cleanupDispatch, ""),
    "notification cleanup calls must stay inside the guarded dispatch",
  ).not.toContain(cleanupFunction);
  expect(uninstall.slice(skipIndex)).toMatch(/^ave_skip_genuine_uninstall:(?:\s+Pop \$R[0-9]){10}\s*$/);
}

describe("machine uninstaller removal", () => {
  it("moves both instances out of the install directory before the elevation wait", () => {
    const template = readTemplate("uninstaller.nsh");
    const multiUser = readTemplate("multiUser.nsh");
    const entry = readTemplate("installer.nsi");
    const mode = readTemplate("oneClick.nsh");
    // Fail on template drift: the post-elevation customization point cannot
    // release the retained outer process's current directory.
    for (const marker of ["SetOutPath $INSTDIR", "!insertmacro initMultiUser", "!insertmacro customUnInit"]) {
      expect(template.indexOf(marker)).toBeGreaterThanOrEqual(0);
    }
    for (const marker of ["!insertmacro customHeader", '!include "uninstaller.nsh"']) {
      expect(entry.indexOf(marker)).toBeGreaterThanOrEqual(0);
    }
    expect(template.indexOf("SetOutPath $INSTDIR")).toBeLessThan(template.indexOf("!insertmacro initMultiUser"));
    expect(template.indexOf("!insertmacro initMultiUser")).toBeLessThan(template.indexOf("!insertmacro customUnInit"));
    expect(multiUser).toContain("!insertmacro UAC_RunElevated\n        Quit");
    expect(entry.indexOf("!insertmacro customHeader")).toBeLessThan(entry.indexOf('!include "uninstaller.nsh"'));
    expect(mode).toMatch(/!macro initMultiUser\s+!ifdef INSTALL_MODE_PER_ALL_USERS\s+!insertmacro setInstallModePerAllUsers\s+!else\s+!insertmacro setInstallModePerUser\s+!endif\s+!macroend/);
    expect(hook).toMatch(/!include "\$\{BUILD_RESOURCES_DIR\}\\uninstaller-init\.nsh"/);
    expect(initialization).toContain("!macroundef initMultiUser");
    expect(initialization).toMatch(/!macro initMultiUser\s+SetOutPath "\$TEMP"\s+!insertmacro setInstallModePerAllUsers\s+!macroend/);
    for (const guard of ["BUILD_UNINSTALLER", "ONE_CLICK", "INSTALL_MODE_PER_ALL_USERS"]) {
      expect(initialization).toContain(`!ifndef ${guard}`);
    }
    const config = JSON.parse(readRepoFile("package.json"));
    expect(config.build.nsis.oneClick).toBe(true);
    expect(config.build.nsis.perMachine).toBe(true);
  });

  it("skips dot entries, closes enumeration handles and still fails for real leftovers", () => {
    const removal = hook.slice(hook.indexOf("!macro customRemoveFiles"), hook.indexOf("ave_remove_files_done:"));
    expect(removal).toContain('FindFirst $R0 $R1 "$INSTDIR\\*.*"');
    expect(removal).toContain('StrCmp $R1 "." ave_remove_files_find_next');
    expect(removal).toContain('StrCmp $R1 ".." ave_remove_files_find_next');
    expect(removal).toMatch(/StrCpy \$R2 "\$INSTDIR\\\$R1"\s+FindClose \$R0\s+Goto ave_remove_files_retry/);
    expect(removal).toContain("FindNext $R0 $R1");
    expect(removal).toMatch(/ave_remove_files_close_empty:\s+FindClose \$R0\s+ave_remove_files_empty:/);
    expect(removal).toMatch(/RMDir "\$INSTDIR"\s+IfFileExists "\$INSTDIR\\\*\.\*" 0 ave_remove_files_done\s+StrCpy \$R2 "\$INSTDIR"/);
    expect(removal).toMatch(/\$\{if\} \$aveSilentUninstallRequested == "1"\s+Goto ave_remove_files_failed/);
    expect(removal).toMatch(/ave_remove_files_failed:\s+SetErrorLevel 1/);
    expect(removal).toContain('Abort "Ave uninstall failed: app files remain at $R2"');
    expect(removal).toContain("IDYES ave_retry_elevated IDNO ave_remove_files_failed");
  });

  it("keeps visible GUI removal errors independent of runtime silent mode", () => {
    const template = readTemplate("uninstaller.nsh");
    expect(template).toMatch(/MessageBox MB_OKCANCEL\|MB_TOPMOST\|MB_SETFOREGROUND/);
    expect(initialization).toMatch(/\$\{StdUtils\.ParameterCnt\} \$R0/);
    expect(initialization).toMatch(/\$\{StdUtils\.ParameterStr\} \$R2 \$R1/);
    expect(initialization).toContain('StrCmpS $R2 "/S" ave_uninstall_arguments_silent');
    expect(initialization).toContain('StrCmpS $R3 "_?=" ave_uninstall_arguments_done');
  });

  it("documents the all-profile toast gap in the Windows release gate", () => {
    const gate = allProfileToastGate();
    expect(gate).toContain("retained initiating user's profile after normal alternate-credential UAC");
    expect(gate).toContain("An already-elevated launch uses the process account's profile");
    expect(gate).toContain("both the per-user Start Menu notification shortcut and the HKCU toast activator CLSID");
    expect(gate).toContain("Keep the all-profile cleanup gate open for signed candidates and unsigned exceptions");
    expect(gate).toContain("Document the supported migration and rollback");
    expect(gate).toContain("both a clean per-machine install and a supported migration from an existing install, run genuine uninstall with the second user signed in and again from a fresh fixture with that user signed out");
    expect(gate).toContain("initiating standard user's session and supply a distinct administrator's credentials");
    expect(gate).toContain("capture both users' owned shortcuts and registration values before uninstall and verify their absence after uninstall before either user relaunches Ave");
    expect(gate).toContain("foreign shortcuts, registry values, and subkeys are unchanged");
    expect(gate).toContain("Empty registry keys may remain after the owned values are removed");
    expect(gate).toContain("capture the shortcut and registration values in both profiles before updater uninstall and again after it completes, before either profile relaunches Ave");
    expect(gate).toContain("Prevent automatic relaunch or capture the post-uninstall state before it occurs");
    expect(gate).toContain("Verify both artifacts survived unchanged in each profile, then verify toast activation for both users");
  });

  it("records per-profile registration as a release limit of the pinned runtime", () => {
    const gate = allProfileToastGate();
    expect(gate).toContain("Release limit — per-profile toast registration");
    expect(gate).toMatch(/v45\.3\.4.*windows_toast_activator\.cc:310–321/);
    expect(gate).toMatch(/`EnsureShortcut\(\);` and `EnsureCLSIDRegistry\(\);` under\s+`if \(!is_packaged\)`/);
    expect(gate).toMatch(/condition uses\s+OS package identity/);
  });

  it("keeps notification cleanup behind the update guards and in the invoking profile", () => {
    expectGuardedToastCleanup(hook);
  });

  it("rejects an updater jump target before notification dispatch", () => {
    const earlySkip = hook.replace(`  ${skipLabel}\n`, "").replace(
      cleanupDispatch,
      `  ${skipLabel}\n${cleanupDispatch}`,
    );
    expect(earlySkip).not.toBe(hook);
    expect(() => expectGuardedToastCleanup(earlySkip)).toThrow("the updater jump must clear the entire cleanup block");
  });

  it("rejects a notification cleanup call after the updater jump target", () => {
    const extraCall = hook.replace(skipLabel, `${skipLabel}\n  Call ${cleanupFunction}`);
    expect(extraCall).not.toBe(hook);
    expect(() => expectGuardedToastCleanup(extraCall)).toThrow(
      "notification cleanup calls must stay inside the guarded dispatch",
    );
  });

  it("retains data even when the legacy deletion flag is supplied", () => {
    const template = readTemplate("uninstaller.nsh");
    expect(template).not.toMatch(/RMDir\s+\/r\s+"\$(?:APPDATA|LOCALAPPDATA)\\/i);
    expect(template).not.toContain('StrCpy $isDeleteAppData "1"');
    expect(template).not.toMatch(/\$\{GetOptions\} \$R0 "--delete-app-data"/);
    expect(template).toMatch(/DeleteRegKey SHELL_CONTEXT "\$\{UNINSTALL_REGISTRY_KEY\}"/);
    expect(template).toContain('Delete "$oldDesktopLink"');
    expect(template).toContain('Delete "$oldStartMenuLink"');
  });

  it("always preserves data without a prompt and accepts the compatibility flag", () => {
    const config = JSON.parse(readRepoFile("package.json"));
    expect(config.build.nsis.deleteAppDataOnUninstall).toBe(false);
    expect(hook).not.toContain("Ave 사용자 데이터를 함께 삭제하시겠습니까?");
    expect(hook).not.toContain("ave_delete_userdata");
    expect(hook).not.toContain("ave_skip_userdata");
    expect(hook).not.toMatch(/MB_YESNO(?:CANCEL)?\|MB_ICONQUESTION/);
    const removedDirectories = [...hook.matchAll(/^\s*RMDir(?: \/r)? "([^"\n]+)"/gm)].map(match => match[1]);
    expect(removedDirectories).toEqual(["$INSTDIR", "$INSTDIR"]);
    expect(hook).toContain("/KEEP_APP_DATA is accepted for updater");
    expect(hook).toContain("compatibility and no longer changes behavior");
    expect(hook).not.toMatch(/\$\{GetOptions\} \$R0 "\/KEEP_APP_DATA"/);
  });
});
