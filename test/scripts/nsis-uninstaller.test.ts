import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../src/__tests__/test-helpers.js";

const hook = readRepoFile("build/installer.nsh");
const initialization = readRepoFile("build/uninstaller-init.nsh");
const templateRoot = resolve("node_modules/app-builder-lib/templates/nsis");
const readTemplate = (name: string) => readFileSync(resolve(templateRoot, name), "utf8");

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
