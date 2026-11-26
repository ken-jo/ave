import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readRepoFile } from "../../src/__tests__/test-helpers.js";

const cleanup = readRepoFile("build/uninstall-windows-notification-artifacts.ps1");
const registryFixture = readRepoFile("test/fixtures/windows-notification-registry.ps1");

const shortcutEvidence = "fixture shortcut evidence";
const productClsid = "{62FD3EFB-B3D2-4235-9402-6979F52C0286}";
const legacyClsid = "{762333EB-F45E-4825-9E7A-61BBADC1AEE6}";

function prepareRegistryFixture(clsid = legacyClsid) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) throw new Error("SystemRoot/WINDIR is required for registry fixtures");
  const installDir = mkdtempSync(join(tmpdir(), "ave-toast-registry-"));
  onTestFinished(() => rmSync(installDir, { recursive: true, force: true }));

  const executable = join(installDir, "Ave.exe");
  const marker = join(installDir, ".ave-nsis-per-machine-v1");
  const shortcut = join(installDir, "Ave.lnk");
  const script = join(installDir, "cleanup.ps1");
  const registry = join(installDir, "registry.json");
  const overlapResult = join(installDir, "overlap.json");
  writeFileSync(marker, "");
  writeFileSync(shortcut, shortcutEvidence);

  // Substitute external lookups in the copied script. Its quarantine, cleanup and exit path run unchanged.
  const programsLookup =
    /\[Environment\]::GetFolderPath\(\s*\[Environment\+SpecialFolder\]::Programs,\s*\[Environment\+SpecialFolderOption\]::DoNotVerify\s*\)/;
  const registryOpen = /\[ToastRegistryKey\]::OpenCurrentUser\(/g;
  expect(cleanup.match(registryOpen)).toHaveLength(2);
  expect(cleanup).toMatch(programsLookup);
  expect(cleanup).toContain("$shortcutMoved = $false");
  const fixtureScript = cleanup
    .replace(programsLookup, "$env:AVE_FIXTURE_DIRECTORY")
    .replace(registryOpen, "[FixtureRegistryKey]::OpenCurrentUser(")
    .replace("$shortcutMoved = $false", () => `${registryFixture}\n$shortcutMoved = $false`);
  writeFileSync(script, fixtureScript);

  const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  function run(scenario = "") {
    return spawnSync(
      powerShell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy", "Bypass",
        "-File", script,
        "-InstalledExecutable", executable,
        "-ShortcutName", "Ave",
        "-AppUserModelId", "ai.example.toast",
        "-InstallMarker", marker,
      ],
      {
        env: {
          ...process.env,
          AVE_FIXTURE_DIRECTORY: installDir,
          AVE_FIXTURE_CLSID: clsid,
          AVE_FIXTURE_REGISTRY: registry,
          AVE_FIXTURE_OVERLAP_RESULT: overlapResult,
          AVE_FIXTURE_SCENARIO: scenario,
        },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
  }

  const initialState = {
    root: { defaultValue: "Electron Notification Activator", CustomActivator: 1, ForeignValue: "root data" },
    server: { defaultValue: executable, ForeignValue: "server data" },
    foreign: { defaultValue: "subkey data" },
  };
  writeFileSync(registry, JSON.stringify(initialState));

  return {
    run,
    initialState,
    readState: () => JSON.parse(readFileSync(registry, "utf8")),
    writeState: (state: unknown) => writeFileSync(registry, JSON.stringify(state)),
    removeShortcut: () => unlinkSync(shortcut),
    quarantineShortcut: () => {
      const quarantined = join(installDir, ".Ave.ave-uninstall-11111111111111111111111111111111.lnk");
      writeFileSync(quarantined, readFileSync(shortcut));
      unlinkSync(shortcut);
      return () => readFileSync(quarantined, "utf8");
    },
    readOverlap: () => JSON.parse(readFileSync(overlapResult, "utf8")),
    expectShortcutPreserved: () => {
      expect(readFileSync(shortcut, "utf8")).toBe(shortcutEvidence);
      expect(readdirSync(installDir).filter((file) => file.endsWith(".lnk"))).toEqual(["Ave.lnk"]);
    },
    expectShortcutRemoved: () => {
      expect(readdirSync(installDir).filter((file) => file.endsWith(".lnk"))).toEqual([]);
    },
  };
}

function expectCleanupFailed(result: SpawnSyncReturns<string>, failureDetail: string) {
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  expect(result.stderr).toContain(failureDetail);
  expect(result.stdout).toContain('"status":"contract-failed"');
  expect(result.stdout).not.toContain('"status":"verified-absent","artifact":"toast-registration"');
}

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
      /\n {2}foreach \(\$registration in @\(Read-ToastRegistrations \$installedExe \$candidateClsids\)\) \{[\s\S]+?if \(Remove-OwnedToastRegistration/,
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

  it.runIf(process.platform === "win32").each([
    ["value read throws", "read-error", "fixture denied the value read"],
    ["a delete silently leaves a value", "delete-noop", "CustomActivator"],
  ])("fails and keeps the owned shortcut when %s", (_label, scenario, failureDetail) => {
    const fixture = prepareRegistryFixture();
    const result = fixture.run(scenario);
    expect(result.stderr).toContain(`fixture exercised ${scenario}`);
    expectCleanupFailed(result, failureDetail);
    fixture.expectShortcutPreserved();
  });

  it.runIf(process.platform === "win32")("fails closed on retry after a partial registry delete", () => {
    const fixture = prepareRegistryFixture();
    const first = fixture.run("delete-error");
    expect(first.stderr).toContain("fixture exercised delete-error");
    expectCleanupFailed(first, "fixture denied deleting CustomActivator");
    fixture.expectShortcutPreserved();

    const partialState = {
      ...fixture.initialState,
      server: { ForeignValue: fixture.initialState.server.ForeignValue },
    };
    expect(fixture.readState()).toEqual(partialState);

    const retry = fixture.run();
    expectCleanupFailed(retry, "incomplete Ave toast registration");
    expect(fixture.readState()).toEqual(partialState);
    fixture.expectShortcutPreserved();
  });

  it.runIf(process.platform === "win32")("recovers product ownership on retry after a partial delete without a shortcut", () => {
    const fixture = prepareRegistryFixture(productClsid);
    fixture.removeShortcut();
    expectCleanupFailed(fixture.run("delete-error"), "fixture denied deleting CustomActivator");
    expect(fixture.readState()).toEqual({
      ...fixture.initialState,
      server: { ForeignValue: fixture.initialState.server.ForeignValue },
    });

    const retry = fixture.run();
    expect(retry.error).toBeUndefined();
    expect(retry.status, `${retry.stdout}\n${retry.stderr}`).toBe(0);
    expect(fixture.readState()).toEqual({
      root: { ForeignValue: fixture.initialState.root.ForeignValue },
      server: { ForeignValue: fixture.initialState.server.ForeignValue },
      foreign: fixture.initialState.foreign,
    });
  });

  it.runIf(process.platform === "win32")("retains legacy ownership when another cleanup overlaps quarantine", () => {
    const fixture = prepareRegistryFixture();
    expectCleanupFailed(fixture.run("overlap"), "fixture stopped the first cleanup");
    const overlap = fixture.readOverlap();
    expect(overlap.evidence).toBe(shortcutEvidence);
    expect(overlap.status, overlap.output).toBe(1);
    expect(overlap.output).toContain('"status":"contract-failed"');
    expect(overlap.output).not.toContain('"status":"verified-absent","artifact":"toast-registration"');
    expect(fixture.readState()).toEqual({
      ...fixture.initialState,
      server: { ForeignValue: fixture.initialState.server.ForeignValue },
    });
    fixture.expectShortcutPreserved();
  });

  it.runIf(process.platform === "win32")("retains a legacy shortcut left in quarantine by an interrupted cleanup", () => {
    const fixture = prepareRegistryFixture();
    const readQuarantine = fixture.quarantineShortcut();
    expectCleanupFailed(fixture.run(), "a prior Ave notification shortcut remains in quarantine");
    expect(readQuarantine()).toBe(shortcutEvidence);
    expect(fixture.readState()).toEqual(fixture.initialState);
  });

  it.runIf(process.platform === "win32").each([
    ["owned slot recreated", "final-owned-write", "survived cleanup"],
    ["foreign slot changed", "final-foreign-write", "changed between final scans"],
    ["second scan read failed", "final-read-error", "fixture denied the final scan read"],
  ])("keeps shortcut evidence when the final registry scan is unstable: %s", (_label, scenario, detail) => {
    const fixture = prepareRegistryFixture();
    const result = fixture.run(scenario);
    expectCleanupFailed(result, detail);
    expect(result.stderr).toContain(`fixture exercised ${scenario}`);
    fixture.expectShortcutPreserved();
    if (scenario === "final-owned-write") {
      expect(fixture.readState().root.defaultValue).toBe(fixture.initialState.root.defaultValue);
    }
    if (scenario === "final-foreign-write") {
      expect(fixture.readState().root.CustomActivator).toBe("foreign data");
    }
  });

  it.runIf(process.platform === "win32").each([
    ["invoking user still has an Ave process", "app-running", "Ave is still running"],
    ["Ave process owner cannot be verified", "owner-lookup-error", "could not verify the owner"],
  ])("fails before mutation when the %s", (_label, scenario, detail) => {
    const fixture = prepareRegistryFixture();
    expectCleanupFailed(fixture.run(scenario), detail);
    expect(fixture.readState()).toEqual(fixture.initialState);
    fixture.expectShortcutPreserved();
  });

  it.runIf(process.platform === "win32")("keeps shortcut evidence when Ave restarts before final verification", () => {
    const fixture = prepareRegistryFixture();
    expectCleanupFailed(fixture.run("app-restarted"), "Ave is still running");
    fixture.expectShortcutPreserved();
  });

  it.runIf(process.platform === "win32").each(["root default", "CustomActivator", "server default"])(
    "removes the lone product %s without a shortcut",
    (slot) => {
      const fixture = prepareRegistryFixture(productClsid);
      fixture.removeShortcut();
      const foreign = {
        root: { ForeignValue: fixture.initialState.root.ForeignValue },
        server: slot === "server default" ? { ForeignValue: fixture.initialState.server.ForeignValue } : null,
        foreign: fixture.initialState.foreign,
      };
      fixture.writeState({
        ...foreign,
        root: {
          ...foreign.root,
          ...(slot === "root default" ? { defaultValue: fixture.initialState.root.defaultValue } : {}),
          ...(slot === "CustomActivator" ? { CustomActivator: 1 } : {}),
        },
        server: slot === "server default" ? fixture.initialState.server : null,
      });

      const result = fixture.run();
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(fixture.readState()).toEqual(foreign);
    },
  );

  it.runIf(process.platform === "win32")("preserves a foreign product slot with the shortcut on failure", () => {
    const fixture = prepareRegistryFixture(productClsid);
    const state = { ...fixture.initialState, root: { ...fixture.initialState.root, CustomActivator: "1" } };
    fixture.writeState(state);
    expectCleanupFailed(fixture.run(), "contains a foreign value in a registration slot");
    expect(fixture.readState()).toEqual(state);
    fixture.expectShortcutPreserved();
  });

  it.runIf(process.platform === "win32").each(["root default", "CustomActivator", "server default"])(
    "fails closed when only the owned %s survives",
    (slot) => {
      const fixture = prepareRegistryFixture();
      const state = {
        root: {
          ForeignValue: fixture.initialState.root.ForeignValue,
          ...(slot === "root default" ? { defaultValue: fixture.initialState.root.defaultValue } : {}),
          ...(slot === "CustomActivator" ? { CustomActivator: 1 } : {}),
        },
        server: slot === "server default" ? fixture.initialState.server : null,
        foreign: fixture.initialState.foreign,
      };
      fixture.writeState(state);

      expectCleanupFailed(fixture.run(), "incomplete Ave toast registration");
      expect(fixture.readState()).toEqual(state);
      fixture.expectShortcutPreserved();
    },
  );

  it.runIf(process.platform === "win32")("preserves foreign values and subkeys after exact cleanup", () => {
    const fixture = prepareRegistryFixture();
    const result = fixture.run("other-user-app");

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('"status":"verified-absent","artifact":"toast-registration"');
    expect(fixture.readState()).toEqual({
      root: { ForeignValue: fixture.initialState.root.ForeignValue },
      server: { ForeignValue: fixture.initialState.server.ForeignValue },
      foreign: fixture.initialState.foreign,
    });
    fixture.expectShortcutRemoved();
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
    expect(cleanup).toContain("-AllowPartial:($registration.Clsid -eq $productClsid)");
    expect(cleanup).toContain("Confirm-ToastRegistrationsAbsent $installedExe $candidateClsids");
    expect(cleanup).not.toMatch(/GetSubKeyNames|ProfileList|HKEY_USERS|NTUSER\.DAT|UsrClass\.dat|RegLoad(?:App)?Key/i);
    const hives = [...cleanup.matchAll(/\bRegistryHive\.(\w+)/g)];
    expect(new Set(hives.map((match) => match[1]))).toEqual(new Set(["CurrentUser"]));
    const registered = cleanup.indexOf("Confirm-ToastRegistrationsAbsent $installedExe $candidateClsids");
    expect(cleanup.indexOf("[System.IO.File]::Delete($quarantinePath)")).toBeGreaterThan(registered);
    expect(cleanup).toContain("[System.IO.File]::Move($quarantinePath, $shortcutPath)");
  });

  it("removes only owned values and allows empty keys in the smoke postcondition", () => {
    expect(cleanup).not.toMatch(/\b(?:DeleteSubKey(?:Tree)?|Remove-Item(?:Property)?)\b/i);
    expect(cleanup.match(/\$(root|server)\.DeleteValue\("[^"]*"\)/g)).toEqual([
      '$server.DeleteValue("")',
      '$root.DeleteValue("CustomActivator")',
      '$root.DeleteValue("")',
    ]);
    const readback = cleanup.slice(cleanup.indexOf("$remainingValues = @("));
    expect(readback.match(/\$(root|server)\.HasValue\("[^"]*"\)/g)).toEqual([
      '$server.HasValue("")',
      '$root.HasValue("CustomActivator")',
      '$root.HasValue("")',
    ]);

    const smoke = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    expect(smoke).toMatch(
      /if \(\s+rootDefault\.valueExists \|\|\s+customActivator\.valueExists \|\|\s+localServer\.valueExists\s+\) \{\s+registrations\.push/,
    );
  });
});
