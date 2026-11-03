// Native run 4: a home verified on its first boot and refused on a later one (a foreign entry added in between) crashed bootstrap
// with "Configuration migration state exists without the requested file". The refused boot looked for configuration at the root,
// which the first boot had already committed to `config/`, so the user never reached the privacy refusal and its fix command.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { _resetAveHomePrivacyForTest, assertAveHomeAcceptsInstalls, getAveHomePrivacyFailure, setAveHomePrivacyAtBoot, AveHomeConfigurationRefusedWriteError, AveHomeConfigurationUntrustedError, aveHomeConfigurationDirectory, verifyAveHomeConfiguration, ensureAveHomePrivate, setAveHomeConfigurationRefusedAtBoot } from "../ave-home.js";
import { readAveHomeConfigurationFile, setAveHomeConfigurationOwner } from "../ave-home-configuration-access.js";
import { migrateAveHomeConfiguration } from "../ave-home-configuration.js";
import { loadPolicy, savePolicy } from "../../permissions/policy-store.js";
import { _resetSessionReviewerSettingsForTest, readPermissionSettings, writePermissionSettings } from "../../permissions/permission-settings-store.js";
import { dispatchPermissionReviewerCommand } from "../../permissions/permission-slash.js";
import { HOME_FOLDER_REFUSED } from "../permissions-events.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { updatePermissionsFile } from "../../permissions/permissions-store.js";
import { readApprovals, recordApproval } from "../../permissions/user-approval-store.js";
import { listStoredProjectRules, projectRulesLocation, readProjectRulesFile, updateProjectRulesFile } from "../../permissions/rules/project-rule-files.js";
import { applyPermissionModeCommand } from "../../permissions/permission-mode-apply.js";
import { DEFAULT_EXECUTION_MODE } from "../permission-mode.js";
import { reconcileWorkspaceRoots } from "../../permissions/workspace-root-reconciler.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const ORIGINAL_PLATFORM = process.platform;

describe.runIf(process.platform !== "win32")("configuration of a home refused after an earlier verified boot", () => {
  let parent: string;
  let home: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "ave-refused-config-"));
    home = join(parent, ".ave");
    vi.stubEnv("AVE_HOME", home);
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
  });
  afterEach(async () => {
    setAveHomeConfigurationOwner(undefined);
    _resetAveHomePrivacyForTest();
    vi.unstubAllEnvs();
    await cleanupTmpDir(parent);
  });

  /** The first, verified boot: protection, then the migration that commits `config/` (it writes the default policy there). */
  function verifiedFirstBoot(): void {
    const privacy = ensureAveHomePrivate(home);
    expect(privacy.enforcement).toBe("posix-mode");
    expect(migrateAveHomeConfiguration(home, privacy)).toEqual([]);
    expect(existsSync(join(home, "config", ".ave-config-migrated"))).toBe(true);
    _resetAveHomePrivacyForTest();
  }

  it("keeps reading the committed config/ on the refused relaunch, so bootstrap reaches the refusal", async () => {
    verifiedFirstBoot();
    // The relaunch: boot refuses the home and never migrates (boot.ts), then the approval gate loads the policy.
    expect(migrateAveHomeConfiguration(home, { enforcement: "none", home, category: "extra-principals", reason: "fixture" })).toEqual([]);
    setAveHomeConfigurationRefusedAtBoot(home);
    expect(aveHomeConfigurationDirectory(home)).toBe(join(home, "config"));
    const policy = await loadPolicy();
    // The committed policy still applies (its default requires explicit approval), rather than nothing or the defaults of absence.
    expect(policy).toMatchObject({ requireExplicitApproval: true, source: "user" });
    expect(readAveHomeConfigurationFile(join(home, "policy.json"))?.toString("utf8")).toContain("requireExplicitApproval");
  });

  it("stays root-only for a refused home that never committed config/", () => {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "settings.json"), '{"legacy":true}');
    setAveHomeConfigurationRefusedAtBoot(home);
    expect(aveHomeConfigurationDirectory(home)).toBe(home);
    // The location stays the root, but its unverified bytes read as absent (R2): a foreign writer could have planted them.
    expect(readAveHomeConfigurationFile(join(home, "settings.json"))).toBeUndefined();
    // A marker that appears later in the run never moves a refused home's configuration.
    mkdirSync(join(home, "config"), { mode: 0o700 });
    writeFileSync(join(home, "config", ".ave-config-migrated"), "ave-home-boundary-v1");
    expect(aveHomeConfigurationDirectory(home)).toBe(home);
  });

  it("refuses a committed marker with the wrong content instead of guessing a location", () => {
    verifiedFirstBoot();
    writeFileSync(join(home, "config", ".ave-config-migrated"), "tampered");
    setAveHomeConfigurationRefusedAtBoot(home);
    expect(() => aveHomeConfigurationDirectory(home)).toThrow(/Configuration marker content is invalid/);
  });
});

// R2 of the home content trust design: on a refused boot every authority store outside a verified boundary reads as absent, apart
// from the closed restriction overlay (deny rules, requireExplicitApproval, managed, blockReadsOutsideWorkingDirectories), and
// writes to those stores are refused so nothing rewrites the user's files from the absent view.
describe.runIf(process.platform !== "win32")("authority stores of a refused home", () => {
  let parent: string;
  let home: string;
  const project = () => join(parent, "project");

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "ave-refused-authority-"));
    home = join(parent, ".ave");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(project());
    vi.stubEnv("AVE_HOME", home);
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
  });
  afterEach(async () => {
    setAveHomeConfigurationOwner(undefined);
    _resetAveHomePrivacyForTest();
    _resetSessionReviewerSettingsForTest();
    vi.unstubAllEnvs();
    await cleanupTmpDir(parent);
  });

  function commitConfiguration(): void {
    const privacy = ensureAveHomePrivate(home);
    expect(migrateAveHomeConfiguration(home, privacy)).toEqual([]);
    _resetAveHomePrivacyForTest();
  }

  function plantPermissions(): void {
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ version: 1, mode: "allow", updatedAt: "", rules: [
      { pattern: "planted_allow_tool", action: "allow" },
      { pattern: "planted_ask_tool", action: "ask" },
      { pattern: "user_denied_tool", action: "deny" },
      { pattern: "planted_allow_tool", action: "deny", tier: "bogus" },
    ] }));
  }

  function plantProjectRules(): string {
    const location = projectRulesLocation(home, project());
    mkdirSync(join(home, "permissions", "project-rules"), { recursive: true });
    writeFileSync(location.filePath, JSON.stringify({ version: 1, projectRoot: location.projectRoot, updatedAt: "", rules: [
      { pattern: "Bash(printf done)", action: "allow" },
      { pattern: "Bash(cat *)", action: "ask" },
      { pattern: "Bash(printf *)", action: "deny" },
    ] }));
    return location.filePath;
  }

  function plantApproval(): void {
    mkdirSync(join(home, "permissions"), { recursive: true });
    writeFileSync(join(home, "permissions", "user-approvals.json"), JSON.stringify({ approvals: {
      planted: { decision: "allow", approvedAt: "2026-11-01T00:00:00.000Z", scope: "persistent", verdictAtApproval: "low", nlJustification: null, revokedAt: null, toolName: "memory_write", source: "builtin" },
    } }));
  }

  async function loadedManager(): Promise<PermissionManager> {
    const manager = new PermissionManager(join(home, "permissions.json"));
    await manager.loadRulesFromFile();
    return manager;
  }

  it("reads a never-committed home's planted root files as absent and applies only their restricting fields", async () => {
    writeFileSync(join(home, "policy.json"), JSON.stringify({ version: 1, requireExplicitApproval: false, managed: true }));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: {
      blockReadsOutsideWorkingDirectories: true, additionalDirectories: [project()], reviewer: { mode: "disabled" },
    } }));
    writeFileSync(join(home, "ave-secrets.json"), JSON.stringify({ version: 1, entries: {} }));
    plantPermissions();
    plantApproval();
    const projectRules = plantProjectRules();
    setAveHomeConfigurationRefusedAtBoot(home);

    for (const name of ["settings.json", "policy.json", "ave-secrets.json"]) expect(readAveHomeConfigurationFile(join(home, name))).toBeUndefined();
    // Strict-OR: the planted `managed: true` restricts; its `requireExplicitApproval: false` widens and is ignored.
    await expect(loadPolicy(undefined, join(parent, "absent-admin.json"))).resolves.toMatchObject({ requireExplicitApproval: true, managed: true, source: "defaults" });
    const settings = readPermissionSettings();
    expect(settings.permissions).toMatchObject({ blockReadsOutsideWorkingDirectories: true, additionalDirectories: [], reviewer: { mode: "llm" } });
    expect(settings.fault).toBeNull();

    const manager = await loadedManager();
    expect(manager.getRulesLoadError()).toBeUndefined();
    expect(manager.getMode()).toBe(DEFAULT_EXECUTION_MODE);
    expect(await manager.listPersistedRules()).toEqual([{ pattern: "user_denied_tool", action: "deny" }]);
    expect(manager.checkDetailed("user_denied_tool", "builtin", "write").decision).toBe("deny");
    expect(manager.checkDetailed("planted_allow_tool", "builtin", "write").decision).not.toBe("allow");
    expect(manager.checkDetailed("planted_ask_tool", "builtin", "read").decision).not.toBe("ask");

    await expect(readApprovals()).resolves.toEqual({ approvals: {} });
    const location = projectRulesLocation(home, project());
    expect(location.filePath).toBe(projectRules);
    await expect(readProjectRulesFile(location)).resolves.toMatchObject({ rules: [{ pattern: "Bash(printf *)", action: "deny" }] });
    expect((await listStoredProjectRules(home)).files.map((file) => file.rules)).toEqual([[{ pattern: "Bash(printf *)", action: "deny" }]]);
  });

  it("applies no widening field from planted root files", async () => {
    writeFileSync(join(home, "policy.json"), JSON.stringify({ version: 1, requireExplicitApproval: false, managed: false }));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { blockReadsOutsideWorkingDirectories: false, additionalDirectories: [project()] } }));
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ version: 1, mode: "allow", updatedAt: "", rules: [{ pattern: "planted_allow_tool", action: "allow" }] }));
    setAveHomeConfigurationRefusedAtBoot(home);
    await expect(loadPolicy(undefined, join(parent, "absent-admin.json"))).resolves.toMatchObject({ requireExplicitApproval: true, managed: false, source: "defaults" });
    expect(readPermissionSettings().permissions).toMatchObject({ blockReadsOutsideWorkingDirectories: false, additionalDirectories: [] });
    const manager = await loadedManager();
    expect(manager.getMode()).toBe(DEFAULT_EXECUTION_MODE);
    expect(await manager.listPersistedRules()).toEqual([]);
    expect(manager.checkDetailed("planted_allow_tool", "builtin", "write").decision).not.toBe("allow");
  });

  it("reads unparseable planted stores as absent without stopping the boot", async () => {
    for (const name of ["policy.json", "settings.json", "permissions.json"]) writeFileSync(join(home, name), "{not json");
    plantApproval();
    writeFileSync(join(home, "permissions", "user-approvals.json"), "{not json");
    const projectRules = plantProjectRules();
    writeFileSync(projectRules, "{not json");
    setAveHomeConfigurationRefusedAtBoot(home);
    await expect(loadPolicy(undefined, join(parent, "absent-admin.json"))).resolves.toMatchObject({ requireExplicitApproval: true, managed: false, source: "defaults" });
    expect(readPermissionSettings()).toMatchObject({ fault: null, permissions: { blockReadsOutsideWorkingDirectories: false } });
    const manager = await loadedManager();
    expect(manager.getRulesLoadError()).toBeUndefined();
    expect(await manager.listPersistedRules()).toEqual([]);
    await expect(readApprovals()).resolves.toEqual({ approvals: {} });
    await expect(readProjectRulesFile(projectRulesLocation(home, project()))).resolves.toBeNull();
    await expect(listStoredProjectRules(home)).resolves.toEqual({ files: [], errors: [] });
  });

  it("ignores the root permissions.json allow rule of a committed refused home and keeps its deny rule", async () => {
    commitConfiguration();
    plantPermissions();
    setAveHomeConfigurationRefusedAtBoot(home);
    // The committed config/ is a verified boundary and stays the configuration.
    await expect(loadPolicy(undefined, join(parent, "absent-admin.json"))).resolves.toMatchObject({ requireExplicitApproval: true, source: "user" });
    const manager = await loadedManager();
    expect(manager.getMode()).toBe(DEFAULT_EXECUTION_MODE);
    expect(await manager.listPersistedRules()).toEqual([{ pattern: "user_denied_tool", action: "deny" }]);
    expect(manager.checkDetailed("planted_allow_tool", "builtin", "write").decision).not.toBe("allow");
    expect(manager.checkDetailed("user_denied_tool", "builtin", "write").decision).toBe("deny");
  });

  it("refuses writes to stores that read as absent and leaves their files untouched", async () => {
    writeFileSync(join(home, "policy.json"), '{"version":1,"requireExplicitApproval":false}');
    writeFileSync(join(home, "settings.json"), '{"permissions":{"additionalDirectories":[]}}');
    plantPermissions();
    plantApproval();
    const projectRules = plantProjectRules();
    const before = new Map([join(home, "policy.json"), join(home, "settings.json"), join(home, "permissions.json"),
      join(home, "permissions", "user-approvals.json"), projectRules].map((path) => [path, readFileSync(path, "utf8")]));
    setAveHomeConfigurationRefusedAtBoot(home);

    await expect(savePolicy({ requireExplicitApproval: true }, undefined, join(parent, "absent-admin.json"))).rejects.toBeInstanceOf(AveHomeConfigurationRefusedWriteError);
    await expect(writePermissionSettings({ reviewer: { mode: "llm" } })).rejects.toBeInstanceOf(AveHomeConfigurationRefusedWriteError);
    await expect(updatePermissionsFile(join(home, "permissions.json"), (file) => { file.rules = []; })).rejects.toBeInstanceOf(AveHomeConfigurationRefusedWriteError);
    const manager = await loadedManager();
    await expect(manager.setModePersist("auto")).rejects.toThrow(/Fix the folder permissions first/);
    await expect(recordApproval("memory_write", "{}", "builtin", { scope: "persistent", verdictAtApproval: "low", nlJustification: null }))
      .rejects.toBeInstanceOf(AveHomeConfigurationRefusedWriteError);
    await expect(updateProjectRulesFile(projectRulesLocation(home, project()), (file) => { file.rules = []; })).rejects.toBeInstanceOf(AveHomeConfigurationRefusedWriteError);
    for (const [path, content] of before) expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("reads a planted FIFO or link at an unverified store as absent without hanging the boot", async () => {
    const decoy = join(parent, "decoy.json");
    writeFileSync(decoy, JSON.stringify({ version: 1, mode: "default", updatedAt: "", rules: [{ pattern: "linked_denied_tool", action: "deny" }] }));
    for (const name of ["policy.json", "settings.json"]) execFileSync("mkfifo", [join(home, name)]);
    execFileSync("mkfifo", [join(home, "permissions.json")]);
    const projectRules = plantProjectRules();
    writeFileSync(projectRules, "");
    execFileSync("rm", [projectRules]);
    symlinkSync(decoy, projectRules);
    setAveHomeConfigurationRefusedAtBoot(home);
    await expect(loadPolicy(undefined, join(parent, "absent-admin.json"))).resolves.toMatchObject({ requireExplicitApproval: true, managed: false, source: "defaults" });
    expect(readPermissionSettings()).toMatchObject({ fault: null, permissions: { blockReadsOutsideWorkingDirectories: false } });
    const manager = await loadedManager();
    expect(manager.getRulesLoadError()).toBeUndefined();
    expect(await manager.listPersistedRules()).toEqual([]);
    await expect(readProjectRulesFile(projectRulesLocation(home, project()))).resolves.toBeNull();
    await expect(listStoredProjectRules(home)).resolves.toEqual({ files: [], errors: [] });

    // A linked root permissions.json is not followed either.
    execFileSync("rm", [join(home, "permissions.json")]);
    symlinkSync(decoy, join(home, "permissions.json"));
    expect(await (await loadedManager()).listPersistedRules()).toEqual([]);
  }, 10_000);

  it("applies a reviewer choice for the session with a notice while the settings store refuses writes", async () => {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { reviewer: { mode: "llm" } } }));
    const before = readFileSync(join(home, "settings.json"), "utf8");
    setAveHomeConfigurationRefusedAtBoot(home);
    await expect(dispatchPermissionReviewerCommand({ verb: "mode", value: "disabled" })).resolves.toMatchObject({
      ok: true, verb: "mode", settings: { mode: "disabled" }, notice: HOME_FOLDER_REFUSED,
    });
    await expect(dispatchPermissionReviewerCommand({ verb: "fallback", value: "rule" })).resolves.toMatchObject({
      ok: true, verb: "fallback", settings: { mode: "disabled", fallbackOnError: "rule" }, notice: HOME_FOLDER_REFUSED,
    });
    expect(readPermissionSettings().permissions.reviewer).toMatchObject({ mode: "disabled", fallbackOnError: "rule" });
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before);
    // The choice lives in memory only: a new run starts from the absent view again.
    _resetSessionReviewerSettingsForTest();
    expect(readPermissionSettings().permissions.reviewer).toMatchObject({ mode: "llm", fallbackOnError: "deny" });
  });

  it("applies a refused durable mode switch for the session and says why it was not saved", async () => {
    setAveHomeConfigurationRefusedAtBoot(home);
    const manager = await loadedManager();
    const result = await applyPermissionModeCommand({ verb: "mode", mode: "auto", durable: true }, {
      permissionManager: manager,
      approvalBypass: { source: "settings-ui", trustOrigin: "user-keyboard", explicitUserAction: true },
    });
    expect(result).toMatchObject({ ok: true, mode: "auto", durable: false, notice: HOME_FOLDER_REFUSED });
    expect(manager.getMode()).toBe("auto");
    expect(existsSync(join(home, "permissions.json"))).toBe(false);
  });

  it("blocks extension installs and updates only while the home is refused", () => {
    expect(() => assertAveHomeAcceptsInstalls()).not.toThrow();
    setAveHomeConfigurationRefusedAtBoot(home);
    expect(() => assertAveHomeAcceptsInstalls()).toThrow(AveHomeConfigurationRefusedWriteError);
    expect(() => assertAveHomeAcceptsInstalls()).toThrow(/install or update extensions.*Fix the folder permissions first/);
  });

  // The boot order of boot.ts: protection reports the refusal, migration is skipped and seals the refused state, then the readers
  // that run before the window (policy, permission settings, rules, workspace-root reconciliation) must neither throw nor write,
  // so the window opens on the refusal notice with R2 applied.
  async function bootRefused(): Promise<PermissionManager> {
    const privacy = { enforcement: "none" as const, home, category: "extra-principals" as const, reason: "fixture" };
    expect(migrateAveHomeConfiguration(home, privacy)).toEqual([]);
    setAveHomeConfigurationRefusedAtBoot(home);
    setAveHomePrivacyAtBoot(privacy);
    await loadPolicy(undefined, join(parent, "absent-admin.json"));
    readPermissionSettings();
    const manager = await loadedManager();
    await reconcileWorkspaceRoots({ source: "boot", permissionManager: manager });
    return manager;
  }

  function expectRefusalNotice(): void {
    setProcessPlatform("win32");
    try { expect(getAveHomePrivacyFailure()).toMatchObject({ enforcement: "none", category: "extra-principals", home }); }
    finally { setProcessPlatform(ORIGINAL_PLATFORM); }
  }

  it("boots a refused never-committed home with planted root files to the refusal notice with R2 applied", async () => {
    const missing = join(parent, "gone");
    writeFileSync(join(home, "policy.json"), JSON.stringify({ version: 1, requireExplicitApproval: false }));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [missing],
      pendingWorkspaceRootRemovals: [{ operationId: "planted", storedPath: missing, runtimePath: missing }] } }));
    plantPermissions();
    const before = ["policy.json", "settings.json", "permissions.json"].map((name) => readFileSync(join(home, name), "utf8"));
    const manager = await bootRefused();
    expect(manager.checkDetailed("planted_allow_tool", "builtin", "write").decision).not.toBe("allow");
    expect(manager.checkDetailed("user_denied_tool", "builtin", "write").decision).toBe("deny");
    expect(["policy.json", "settings.json", "permissions.json"].map((name) => readFileSync(join(home, name), "utf8"))).toEqual(before);
    expect(existsSync(join(home, "config", ".ave-config-migrated"))).toBe(false);
    expectRefusalNotice();
  });

  it("boots a refused committed home whose stale workspace root needs a grant prune, leaving the removal pending", async () => {
    commitConfiguration();
    const missing = join(parent, "gone");
    await writePermissionSettings({ additionalDirectories: [missing] });
    plantPermissions();
    const before = readFileSync(join(home, "permissions.json"), "utf8");
    await bootRefused();
    // The prune would rewrite root permissions.json from its absent view; it is refused, so the removal stays pending for a trusted boot.
    expect(readFileSync(join(home, "permissions.json"), "utf8")).toBe(before);
    expect(readPermissionSettings().permissions.pendingWorkspaceRootRemovals).toEqual([expect.objectContaining({ storedPath: missing })]);
    expectRefusalNotice();
  });

  it("keeps a trusted home's stores readable and writable", async () => {
    commitConfiguration();
    writeFileSync(join(home, "permissions.json"), JSON.stringify({ version: 1, mode: "allow", updatedAt: "", rules: [{ pattern: "planted_allow_tool", action: "allow" }] }));
    const manager = await loadedManager();
    expect(manager.getMode()).toBe("allow");
    expect(manager.checkDetailed("planted_allow_tool", "builtin", "write").decision).toBe("allow");
    await expect(updatePermissionsFile(join(home, "permissions.json"), (file) => { file.mode = "default"; })).resolves.toBeUndefined();
  });
});

describe.runIf(process.platform !== "win32")("POSIX home protection hint", () => {
  let parent: string;
  let home: string;

  beforeEach(() => {
    // A home path a shell would expand or split if the hint did not quote it.
    parent = mkdtempSync(join(tmpdir(), "ave-hint-$HOME `id` it's-"));
    home = join(parent, ".ave");
    vi.stubEnv("AVE_HOME", home);
    setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => true });
    const privacy = ensureAveHomePrivate(home);
    expect(migrateAveHomeConfiguration(home, privacy)).toEqual([]);
    _resetAveHomePrivacyForTest();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    chmodSync(home, 0o700);
    setAveHomeConfigurationOwner(undefined);
    _resetAveHomePrivacyForTest();
    vi.unstubAllEnvs();
    await cleanupTmpDir(parent);
  });

  const quoted = () => `'${home.replace(/'/g, "'\\''")}'`;

  it("names chmod go-w with the shell-quoted path when group or others can write to the home", () => {
    chmodSync(home, 0o777);
    expect(() => verifyAveHomeConfiguration(home)).toThrow(AveHomeConfigurationUntrustedError);
    expect(() => verifyAveHomeConfiguration(home)).toThrow(`group or others can write to the folder. Fix it with: chmod go-w ${quoted()}`);
    // The quoted word reads back as the exact path in a POSIX shell.
    expect(execFileSync("/bin/sh", ["-c", `printf %s ${quoted()}`], { encoding: "utf8" })).toBe(home);
  });

  it("names chown, not chmod, when another account owns the home", () => {
    const uid = process.getuid!();
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    let message = "";
    try { verifyAveHomeConfiguration(home); } catch (error) { message = (error as Error).message; }
    expect(message).toContain(`owned by another account. Fix it with: sudo chown "$(id -u)" ${quoted()}`);
    expect(message).not.toContain("chmod");
  });
});
