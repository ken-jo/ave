import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { readRepoFile } from "../../src/__tests__/test-helpers.js";

const cleanup = readRepoFile("build/uninstall-windows-notification-artifacts.ps1");
const registryFixture = readRepoFile("test/fixtures/windows-notification-registry.ps1");

const shortcutEvidence = "fixture shortcut evidence";
const productClsid = "{62FD3EFB-B3D2-4235-9402-6979F52C0286}";
const legacyClsid = "{762333EB-F45E-4825-9E7A-61BBADC1AEE6}";
const lockName = ".ave-notification-cleanup.lock";
const lockLookup = /\[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::ApplicationData\)/;
const quarantineName = (id: string) => `.Ave.ave-uninstall-${id.repeat(32)}.lnk`;

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
  const signal = join(installDir, "product-start.signal");
  writeFileSync(marker, "");
  writeFileSync(shortcut, shortcutEvidence);

  // Substitute external lookups in the copied script. Its quarantine, cleanup and exit path run unchanged.
  const programsLookup =
    /\[Environment\]::GetFolderPath\(\s*\[Environment\+SpecialFolder\]::Programs,\s*\[Environment\+SpecialFolderOption\]::DoNotVerify\s*\)/;
  const registryOpen = /\[ToastRegistryKey\]::OpenCurrentUser\(/g;
  expect(cleanup.match(registryOpen)).toHaveLength(2);
  expect(cleanup).toMatch(programsLookup);
  expect(cleanup).toContain("$shortcutMoved = $false");
  // The lock must land in the fixture directory, never in the real profile.
  if (cleanup.includes(lockName)) expect(cleanup).toMatch(lockLookup);
  const fixtureScript = cleanup
    .replace(programsLookup, "$env:AVE_FIXTURE_DIRECTORY")
    .replace(lockLookup, "$env:AVE_FIXTURE_DIRECTORY")
    .replace(registryOpen, "[FixtureRegistryKey]::OpenCurrentUser(")
    .replace("$shortcutMoved = $false", () => `${registryFixture}\n$shortcutMoved = $false`);
  writeFileSync(script, fixtureScript);

  const powerShell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-InstalledExecutable", executable,
    "-ShortcutName", "Ave",
    "-AppUserModelId", "ai.example.toast",
    "-InstallMarker", marker,
  ];
  const environment = (scenario: string) => ({
    ...process.env,
    AVE_FIXTURE_DIRECTORY: installDir,
    AVE_FIXTURE_CLSID: clsid,
    AVE_FIXTURE_REGISTRY: registry,
    AVE_FIXTURE_OVERLAP_RESULT: overlapResult,
    AVE_FIXTURE_SIGNAL: signal,
    // The scan that precedes shortcut disposal, however many the script runs.
    AVE_FIXTURE_FINAL_SCANS: cleanup.match(/for \(\$pass = 0; \$pass -lt (\d+)/)?.[1] ?? "1",
    AVE_FIXTURE_SCENARIO: scenario,
  });

  function run(scenario = "") {
    return spawnSync(powerShell, args, {
      env: environment(scenario),
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
  }

  /** Waits for the fixture to pause, then lets `onPaused` answer for an Ave start. */
  async function runPaused(onPaused: () => "provisioned" | "exited", scenario = "product-start") {
    const child = spawn(powerShell, args, { env: environment(scenario), windowsHide: true });
    onTestFinished(() => void child.kill());
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    const deadline = Date.now() + 20_000;
    while (!existsSync(signal) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(signal), `${stdout}\n${stderr}`).toBe(true);
    writeFileSync(`${signal}.tmp`, onPaused());
    renameSync(`${signal}.tmp`, `${signal}.ack`);
    return { status: await closed, stdout, stderr };
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
    installDir,
    runPaused,
    writeShortcut: (content: string) => writeFileSync(shortcut, content),
    readShortcut: () => readFileSync(shortcut, "utf8"),
    quarantineShortcut: () => {
      writeFileSync(join(installDir, quarantineName("1")), readFileSync(shortcut));
      unlinkSync(shortcut);
    },
    shortcuts: () => readdirSync(installDir).filter((file) => file.endsWith(".lnk")),
    readOverlap: () => JSON.parse(readFileSync(overlapResult, "utf8")),
    expectShortcutPreserved: () => {
      expect(readFileSync(shortcut, "utf8")).toBe(shortcutEvidence);
      expect(readdirSync(installDir).filter((file) => file.endsWith(".lnk"))).toEqual(["Ave.lnk"]);
    },
    // A cleanup that deleted registry values keeps the shortcut in quarantine for the next run.
    expectShortcutQuarantined: () => {
      const files = readdirSync(installDir).filter((file) => file.endsWith(".lnk"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\.Ave\.ave-uninstall-[0-9a-f]{32}\.lnk$/);
      expect(readFileSync(join(installDir, files[0]), "utf8")).toBe(shortcutEvidence);
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

function expectCleanupSucceeded(result: { error?: Error; status: number | null; stdout: string; stderr: string }, status = 0) {
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
  expect(result.stdout).toContain('"status":"verified-absent","artifact":"toast-registration"');
  expect(result.stdout).not.toContain('"artifact":"notification-artifacts"');
}

function foreignOnly(state: { root: { ForeignValue: string }; server: { ForeignValue: string }; foreign: unknown }) {
  return {
    root: { ForeignValue: state.root.ForeignValue },
    server: { ForeignValue: state.server.ForeignValue },
    foreign: state.foreign,
  };
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
    if (scenario === "read-error") fixture.expectShortcutPreserved();
    else fixture.expectShortcutQuarantined();
  });

  it.runIf(process.platform === "win32")("resumes from the quarantined shortcut on retry after a partial registry delete", () => {
    const fixture = prepareRegistryFixture();
    const first = fixture.run("delete-error");
    expect(first.stderr).toContain("fixture exercised delete-error");
    expectCleanupFailed(first, "fixture denied deleting CustomActivator");
    fixture.expectShortcutQuarantined();
    expect(fixture.readState()).toEqual({
      ...fixture.initialState,
      server: { ForeignValue: fixture.initialState.server.ForeignValue },
    });

    expectCleanupSucceeded(fixture.run());
    expect(fixture.readState()).toEqual(foreignOnly(fixture.initialState));
    fixture.expectShortcutRemoved();
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

  it.runIf(process.platform === "win32")("preserves a pre-existing nonempty cleanup lock byte for byte", () => {
    const fixture = prepareRegistryFixture();
    const lock = join(fixture.installDir, lockName);
    const sentinel = Buffer.from([0x00, 0x41, 0xff, 0x0a]);
    writeFileSync(lock, sentinel);

    const result = fixture.run();
    expect(existsSync(lock), "pre-existing lock file was deleted").toBe(true);
    expect(readFileSync(lock)).toEqual(sentinel);
    expectCleanupFailed(result, "notification cleanup lock path is occupied");
    expect(fixture.readState()).toEqual(fixture.initialState);
    fixture.expectShortcutPreserved();
  });

  it.runIf(process.platform === "win32")("retains legacy ownership when another cleanup overlaps quarantine", () => {
    const fixture = prepareRegistryFixture();
    expectCleanupFailed(fixture.run("overlap"), "fixture stopped the first cleanup");
    const overlap = fixture.readOverlap();
    expect(overlap.evidence).toBe(shortcutEvidence);
    expect(overlap.status, overlap.output).toBe(1);
    expect(overlap.output).toContain("notification cleanup lock path is occupied");
    expect(overlap.output).toContain('"status":"contract-failed"');
    expect(overlap.output).not.toContain('"status":"verified-absent","artifact":"toast-registration"');
    expect(fixture.readState()).toEqual({
      ...fixture.initialState,
      server: { ForeignValue: fixture.initialState.server.ForeignValue },
    });
    fixture.expectShortcutQuarantined();
  });

  it.runIf(process.platform === "win32").each([
    ["just after the move", false],
    ["during registry deletion", true],
  ])("resumes an owned shortcut left in quarantine by a cleanup terminated %s", (_label, partial) => {
    const fixture = prepareRegistryFixture();
    fixture.quarantineShortcut();
    if (partial) {
      fixture.writeState({
        ...fixture.initialState,
        server: { ForeignValue: fixture.initialState.server.ForeignValue },
      });
    }

    const result = fixture.run();
    expectCleanupSucceeded(result);
    expect(result.stdout).toContain(quarantineName("1"));
    expect(fixture.readState()).toEqual(foreignOnly(fixture.initialState));
    fixture.expectShortcutRemoved();
  });

  it.runIf(process.platform === "win32")("resumes the quarantined shortcut when the product recreated the original", () => {
    const fixture = prepareRegistryFixture();
    fixture.quarantineShortcut();
    fixture.writeShortcut("fixture product shortcut");

    expectCleanupSucceeded(fixture.run());
    expect(fixture.readState()).toEqual(foreignOnly(fixture.initialState));
    fixture.expectShortcutRemoved();
  });

  it.runIf(process.platform === "win32")("resumes the quarantined shortcut and preserves a foreign file at its original path", () => {
    const fixture = prepareRegistryFixture();
    fixture.quarantineShortcut();
    fixture.writeShortcut("fixture foreign shortcut");

    const result = fixture.run();
    expectCleanupSucceeded(result);
    expect(result.stdout).toContain("preserved different-target shortcut");
    expect(fixture.readState()).toEqual(foreignOnly(fixture.initialState));
    expect(fixture.shortcuts()).toEqual(["Ave.lnk"]);
    expect(fixture.readShortcut()).toBe("fixture foreign shortcut");
  });

  it.runIf(process.platform === "win32")("reports unattributable quarantine entries without touching them or blocking cleanup", () => {
    const fixture = prepareRegistryFixture();
    const directory = join(fixture.installDir, quarantineName("a"));
    const unreadable = join(fixture.installDir, quarantineName("b"));
    mkdirSync(directory);
    writeFileSync(join(directory, "kept.txt"), "unrelated");
    writeFileSync(unreadable, "not a fixture shortcut");
    const expectEntriesUntouched = () => {
      expect(fixture.shortcuts().sort()).toEqual([quarantineName("a"), quarantineName("b")]);
      expect(readFileSync(join(directory, "kept.txt"), "utf8")).toBe("unrelated");
      expect(readFileSync(unreadable, "utf8")).toBe("not a fixture shortcut");
    };

    for (const result of [fixture.run(), fixture.run()]) {
      expectCleanupSucceeded(result, 2);
      expect(result.stdout.match(/"status":"foreign-preserved","artifact":"shortcut-quarantine"/g)).toHaveLength(2);
      expect(fixture.readState()).toEqual(foreignOnly(fixture.initialState));
      expectEntriesUntouched();
    }

    // A real failure still outranks the report-only exit.
    fixture.writeState(fixture.initialState);
    fixture.writeShortcut(shortcutEvidence);
    expectCleanupFailed(fixture.run("read-error"), "fixture denied the value read");
    expect(fixture.readState()).toEqual(fixture.initialState);
    expect(fixture.readShortcut()).toBe(shortcutEvidence);
  });

  it.runIf(process.platform === "win32")("keeps shortcut evidence when the final registry read fails", () => {
    const fixture = prepareRegistryFixture();
    const result = fixture.run("final-read-error");
    expectCleanupFailed(result, "fixture denied the final scan read");
    expect(result.stderr).toContain("fixture exercised final-read-error");
    fixture.expectShortcutQuarantined();
  });

  it.runIf(process.platform === "win32")("holds a lock that stops an Ave start during the last registry scan from provisioning", async () => {
    const { isWindowsNotificationCleanupInProgress } = await import("../../src/main/windows-notification-cleanup-lock.js");
    const fixture = prepareRegistryFixture();
    expect(isWindowsNotificationCleanupInProgress(fixture.installDir)).toBe(false);

    // The fixture stands in for the provisioning that follows the real startup probe.
    let lockSeen: boolean | undefined;
    const result = await fixture.runPaused(() => {
      lockSeen = isWindowsNotificationCleanupInProgress(fixture.installDir);
      return lockSeen ? "exited" : "provisioned";
    });

    expectCleanupSucceeded(result);
    expect(fixture.readState()).toEqual(foreignOnly(fixture.initialState));
    expect(lockSeen).toBe(true);
    fixture.expectShortcutRemoved();
    expect(isWindowsNotificationCleanupInProgress(fixture.installDir)).toBe(false);
    expect(existsSync(join(fixture.installDir, lockName))).toBe(false);
  });

  it.runIf(process.platform === "win32")("allows startup when an unrelated process holds a foreign lock file exclusively", async () => {
    const { isWindowsNotificationCleanupInProgress } = await import("../../src/main/windows-notification-cleanup-lock.js");
    const fixture = prepareRegistryFixture();
    writeFileSync(join(fixture.installDir, lockName), "foreign file");

    const result = await fixture.runPaused(
      () => isWindowsNotificationCleanupInProgress(fixture.installDir) ? "exited" : "provisioned",
      "unrelated-lock",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("provisioned");
  });

  it("takes the lock that the product startup probes before checking for a running Ave", async () => {
    const lock = await import("../../src/main/windows-notification-cleanup-lock.js");
    expect(lock.WINDOWS_NOTIFICATION_CLEANUP_LOCK).toBe(lockName);
    expect(cleanup).toMatch(lockLookup);
    expect(cleanup).toMatch(
      /\(Join-Path \$lockDirectory "\.ave-notification-cleanup\.lock"\),\s+\[System\.IO\.FileMode\]::CreateNew,\s+\[System\.IO\.FileAccess\]::ReadWrite,\s+\(\[System\.IO\.FileShare\]::Read -bor \[System\.IO\.FileShare\]::Delete\),\s+1,\s+\[System\.IO\.FileOptions\]::DeleteOnClose/,
    );
    const stopped = [...cleanup.matchAll(/^\s*Assert-AveStopped /gm)];
    expect(stopped).toHaveLength(1);
    expect(cleanup).toContain('$cleanupLock.Lock(0, 1)');
    expect(stopped[0].index).toBeGreaterThan(cleanup.indexOf("$cleanupLock.Flush()"));
    expect(stopped[0].index).toBeLessThan(cleanup.indexOf("Get-QuarantinedShortcuts $programs"));
    expect(cleanup).not.toMatch(/Mutex/);

    const boot = readRepoFile("src/main/early-boot-env.ts");
    const probe = boot.indexOf('isWindowsNotificationCleanupInProgress(app.getPath("appData"))');
    expect(probe).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(boot.indexOf("app.setToastActivatorCLSID("));
  });

  it.runIf(process.platform === "win32").each([
    ["a complete legacy registration", legacyClsid],
    ["a partial product registration without a shortcut", productClsid],
  ])("preserves a foreign value that replaces a slot during deletion of %s", (_label, clsid) => {
    const fixture = prepareRegistryFixture(clsid);
    if (clsid === productClsid) {
      fixture.removeShortcut();
      fixture.writeState({
        ...fixture.initialState,
        root: { CustomActivator: 1, ForeignValue: fixture.initialState.root.ForeignValue },
      });
    }
    const replaced = {
      ...fixture.readState(),
      root: { ...fixture.readState().root, CustomActivator: "foreign data" },
      server: { ForeignValue: fixture.initialState.server.ForeignValue },
    };

    const result = fixture.run("foreign-replace");
    expect(result.stderr).toContain("fixture exercised foreign-replace");
    expectCleanupFailed(result, "the CustomActivator registration slot changed to a foreign value before deletion");
    expect(fixture.readState()).toEqual(replaced);
    if (clsid === legacyClsid) fixture.expectShortcutQuarantined();

    // A later cleanup never deletes the replacement; beside a remaining owned slot it fails closed.
    const retry = fixture.run();
    if (clsid === legacyClsid) {
      expectCleanupFailed(retry, "contains a foreign value in a registration slot");
      fixture.expectShortcutQuarantined();
    } else {
      expectCleanupSucceeded(retry);
    }
    expect(fixture.readState()).toEqual(replaced);
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
    // A CLSID becomes a candidate only from a shortcut whose exact ownership was read at its quarantine path.
    expect(cleanup).toMatch(
      /function Get-OwnedShortcutClsid \{[\s\S]+?Get-ShortcutOwnershipMismatches \$record [^)]+\)\s+if \(\$ownershipMismatches\.Count -ne 0\) \{\s+throw [^\n]+\s+\}\s+return \(\[guid\]\$record\.ToastClsid\)\.ToString\("B"\)\s+\}/,
    );
    expect(cleanup).toMatch(
      /\$verifiedClsid = Get-OwnedShortcutClsid \$quarantinePath \$expectedShortcut\s+if \(\$verifiedClsid -ne \(\[guid\]\$record\.ToastClsid\)\.ToString\("B"\)\) \{\s+throw [^}]+\}[\s\S]+?if \(\$candidateClsids -notcontains \$verifiedClsid\) \{ \$candidateClsids \+= \$verifiedClsid \}/,
    );
    expect(cleanup).toMatch(/try \{ \$clsid = Get-OwnedShortcutClsid \$entry \$Expected \}\s+catch \{\}/);
    expect(cleanup.match(/^\s*(?:if \([^\n]+\) \{ )?\$candidateClsids\s*(?:\+?=)/gm)).toHaveLength(3);
    // Incomplete tuples are removable only at the product CLSID or one named by a shortcut found in quarantine.
    expect(cleanup.match(/^\s*\$partialClsids\s*(?:\+?=)[^\n]*/gm)?.map((line) => line.trim())).toEqual([
      "$partialClsids = @($productClsid)",
      "$partialClsids += $entry.Clsid",
    ]);
    expect(cleanup).toContain("-AllowPartial:($partialClsids -contains $registration.Clsid)");
    expect(cleanup).toContain("Confirm-ToastRegistrationsAbsent $installedExe $candidateClsids");
    expect(cleanup).not.toMatch(/GetSubKeyNames|ProfileList|HKEY_USERS|NTUSER\.DAT|UsrClass\.dat|RegLoad(?:App)?Key/i);
    const hives = [...cleanup.matchAll(/\bRegistryHive\.(\w+)/g)];
    expect(new Set(hives.map((match) => match[1]))).toEqual(new Set(["CurrentUser"]));
    const registered = cleanup.indexOf("Confirm-ToastRegistrationsAbsent $installedExe $candidateClsids");
    expect(cleanup.indexOf("[System.IO.File]::Delete($entry.Path)")).toBeGreaterThan(registered);
    expect(cleanup).toContain("[System.IO.File]::Move($quarantinePath, $shortcutPath)");
  });

  it("removes only owned values and allows empty keys in the smoke postcondition", () => {
    expect(cleanup).not.toMatch(/\b(?:DeleteSubKey(?:Tree)?|Remove-Item(?:Property)?)\b/i);
    // Each delete is gated by a reread of that slot at the deletion boundary.
    expect(
      cleanup.match(/Test-ToastSlotStillOwned \$(?:root|server) "[^"]*" \$\w+ \w+ \$ExpectedExecutable\)+ \{\s+\$(?:root|server)\.DeleteValue\(/g),
    ).toHaveLength(3);
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
