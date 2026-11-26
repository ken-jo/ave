import { describe, expect, it } from "vitest";
import { readRepoFile } from "../../src/__tests__/test-helpers.js";

const cleanup = readRepoFile("build/uninstall-windows-notification-artifacts.ps1");

describe("current-user toast cleanup", () => {
  it("preserves a same-target shortcut with missing ownership fields", () => {
    expect(cleanup).toMatch(/\[AllowNull\(\)\]\[AllowEmptyString\(\)\]\[string\]\$Left/);
    expect(cleanup).toContain("if ([string]::IsNullOrWhiteSpace($Left)) { return $false }");
    expect(cleanup).toMatch(
      /if \(-not \(Test-SamePath \$Record\.WorkingDirectory \$ExpectedWorkingDirectory\)\) \{\s+\$mismatches \+= "workingDirectory"/,
    );
    expect(cleanup).toMatch(
      /if \(\$mismatches\.Count -ne 0\) \{\s+Write-CleanupEvent "foreign-preserved" "shortcut"/,
    );
  });

  it("continues to registry cleanup when Programs or its shortcut is missing", () => {
    expect(cleanup).toMatch(
      /\[Environment\]::GetFolderPath\(\s+\[Environment\+SpecialFolder\]::Programs,\s+\[Environment\+SpecialFolderOption\]::DoNotVerify\s+\)/,
    );
    expect(cleanup).toMatch(
      /\$shortcutAttributes = Get-ShortcutAttributes \$shortcutPath\s+if \(\$null -eq \$shortcutAttributes\) \{\s+Write-CleanupEvent "verified-absent" "shortcut"[^}]+\}\s+elseif/,
    );
    expect(cleanup).toMatch(
      /\n {2}foreach \(\$registration in @\(Find-ExactToastRegistrations \$installedExe \$candidateClsids\)\) \{\s+if \(Remove-ExactToastRegistration/,
    );
  });

  it("fails closed when either lookup is denied", () => {
    expect(cleanup).toMatch(
      /function Get-ShortcutAttributes \{[^}]+\{\s+return \[System\.IO\.File\]::GetAttributes\(\$Path\)\s+\}\s+catch \[System\.IO\.FileNotFoundException\], \[System\.IO\.DirectoryNotFoundException\] \{\s+return \$null\s+\}\s+\}/,
    );
    expect(cleanup).toContain("$shortcutAttributes = Get-ShortcutAttributes $shortcutPath");
    expect(cleanup).toContain("$shortcutResidue = Get-ShortcutAttributes $shortcutPath");
    expect(cleanup).toMatch(/\ncatch \{[\s\S]+Write-CleanupEvent "contract-failed" "notification-artifacts"[\s\S]+exit 1/);
  });

  it("matches registrations at the product CLSID and the exact CLSID from a verified shortcut", () => {
    const boot = readRepoFile("src/main/early-boot-env.ts");
    const pinnedClsid = boot.match(/const WINDOWS_TOAST_ACTIVATOR_CLSID =\s*"([^"]+)"/)?.[1];
    expect(pinnedClsid).toBe("{62FD3EFB-B3D2-4235-9402-6979F52C0286}");
    expect(cleanup).toContain(`$productClsid = "${pinnedClsid}"`);
    expect(cleanup).toContain("$candidateClsids = @($productClsid)");
    expect(cleanup).toMatch(
      /\$quarantinedMismatches = @\(\s+Get-ShortcutOwnershipMismatches \$quarantinedRecord [^)]+\)\s+if \(\$quarantinedMismatches\.Count -ne 0\) \{[\s\S]+?\$verifiedClsid = \(\[guid\]\$quarantinedRecord\.ToastClsid\)\.ToString\("B"\)/,
    );
    expect(cleanup).toMatch(
      /if \(\$verifiedClsid -ne \(\[guid\]\$record\.ToastClsid\)\.ToString\("B"\)\) \{\s+throw [^}]+\}\s+if \(\$verifiedClsid -ne \$productClsid\) \{\s+\$candidateClsids \+= \$verifiedClsid\s+\}/,
    );
    expect(cleanup.match(/^\s*\$candidateClsids\s*(?:\+?=)/gm)).toHaveLength(2);
    expect(cleanup).toMatch(/foreach \(\$clsid in \$CandidateClsids\) \{\s+if \(Test-ExactToastRegistration \$view \$clsid \$ExpectedExecutable\)/);
    expect(cleanup).toContain("$remaining = @(Find-ExactToastRegistrations $installedExe $candidateClsids)");
    expect(cleanup).not.toMatch(/GetSubKeyNames|ProfileList|HKEY_USERS|NTUSER\.DAT|UsrClass\.dat|RegLoad(?:App)?Key/i);
    const hives = [...cleanup.matchAll(/\[Microsoft\.Win32\.RegistryHive\]::(\w+)/g)];
    expect(new Set(hives.map((match) => match[1]))).toEqual(new Set(["CurrentUser"]));
    const registered = cleanup.indexOf("$remaining = @(Find-ExactToastRegistrations");
    expect(cleanup.indexOf("[System.IO.File]::Delete($quarantinePath)")).toBeGreaterThan(registered);
    expect(cleanup).toContain("[System.IO.File]::Move($quarantinePath, $shortcutPath)");
  });

  it("removes only owned values and allows empty keys in the smoke postcondition", () => {
    expect(cleanup).not.toMatch(/\b(?:DeleteSubKey(?:Tree)?|Remove-Item(?:Property)?)\b/i);
    expect(cleanup.match(/\$(root|server)\.DeleteValue\("[^"]*", \$false\)/g)).toEqual([
      '$server.DeleteValue("", $false)',
      '$root.DeleteValue("CustomActivator", $false)',
      '$root.DeleteValue("", $false)',
    ]);

    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    expect(smoke).toMatch(
      /if \(\s+rootDefault\.valueExists \|\|\s+customActivator\.valueExists \|\|\s+localServer\.valueExists\s+\) \{\s+registrations\.push/,
    );
  });
});
