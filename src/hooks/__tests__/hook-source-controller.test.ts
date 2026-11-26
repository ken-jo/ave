import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { configureHostResources } from "../../main/host-resources.js";
import { wireHookSystem } from "../../boot/steps/hook-system-wiring.js";
import { listRuntimeHookTrustState, reviewRuntimeHookTrust } from "../hook-source-controller.js";
import { loadHookConfig } from "../hook-config-trust.js";
import { readLockfile } from "../hook-discovery.js";
import { loadHookRuntimePolicy, type HookRuntimePolicy } from "../hook-source-policy.js";
import { acceptHookTrust } from "../hook-trust-commands.js";
import { readWindowsDacls, windowsPolicyDescriptor, windowsPolicyTrustFailure } from "../../shared/windows-path-facts.js";
import { hookDirLayout, writeExecutableHook } from "./test-helpers.js";
import * as hostWorkspaceGate from "../../shared/host-workspace-gate.js";

// Whether a real temp file is trusted depends on who runs the tests (an elevated runner owns it as an administrator), so
// cases that need a fixed owner and DACL substitute them in the real native snapshot; the production trust check still
// runs on that evidence. Each side is null for the real facts, or the owner and the one full-control SID to report.
type InjectedSecurity = { owner: string; writer: string } | null;
const injected = vi.hoisted(() => ({ file: null as InjectedSecurity, parent: null as InjectedSecurity }));
vi.mock("../../shared/windows-path-facts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/windows-path-facts.js")>();
  const inject = (dacl: import("../../shared/windows-path-facts.js").WindowsDacl | null | undefined, security: InjectedSecurity) =>
    dacl && security ? { ...dacl, owner: security.owner, aces: [{ type: 0, flags: 0, mask: 0x1f01ff, sid: security.writer }] } : dacl;
  return { ...actual, readWindowsDacls: (...args: Parameters<typeof actual.readWindowsDacls>) => {
    const rows = actual.readWindowsDacls(...args);
    return rows.map((row) => ({ ...row, dacl: inject(row.dacl, injected.file) ?? null, parent: inject(row.parent, injected.parent) }));
  } };
});
const ADMINISTRATORS = "S-1-5-32-544";
const ORDINARY_USER = "S-1-5-21-1000000000-1000000000-1000000000-1001";
const administratorOnly = { owner: ADMINISTRATORS, writer: ADMINISTRATORS };
const injectAdministratorFacts = () => { injected.file = administratorOnly; injected.parent = administratorOnly; };

let root: string;
// Windows reads the admin policy through a native helper; an uncomposed host reads it as unreadable and closes user hooks.
beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "hook-sources-")); });
afterEach(async () => { injected.file = null; injected.parent = null; await cleanupTmpDir(root); });
const openPolicy = (): HookRuntimePolicy => ({ allowManagedHooksOnly: false, allowedHttpHookUrls: [], httpHookAllowedEnvVars: [], managedHooks: [] });

describe("source-bound hook review", () => {
  it("refuses a definition swapped during asynchronous command approval", async () => {
    const layout = hookDirLayout(root);
    const marker = join(root, "unreviewed-executed");
    writeExecutableHook(layout.hooksDir, "pre-race.sh");
    let approvals = 0;
    const { manager } = await wireHookSystem({ ...layout, policy: openPolicy(), authorizeCommand: async () => {
      approvals += 1;
      await Promise.resolve();
      writeExecutableHook(layout.hooksDir, "pre-race.sh", `#!/bin/sh\ntouch '${marker}'\n`);
      return { decision: "allow", reason: "approved" };
    } });
    const row = listRuntimeHookTrustState(manager).disabled[0];
    await reviewRuntimeHookTrust(manager, { sourceId: "user", fileName: row.fileName, expectedSha256: row.sha256, action: "accept" });
    const result = await manager.runPreToolUse({ toolName: "read_file", source: "builtin", category: "read", input: {},
      sessionId: "approval-race", trustOrigin: "user-keyboard" }, { cwd: root });
    expect(approvals).toBe(1);
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("Hook definition changed");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects stale review and preserves changed hash state through quarantine", async () => {
    const layout = hookDirLayout(root);
    writeExecutableHook(layout.hooksDir, "pre-review.sh");
    const { manager } = await wireHookSystem({ ...layout, policy: openPolicy() });
    let row = listRuntimeHookTrustState(manager).disabled[0];
    expect(row).toMatchObject({ sourceId: "user", hookSource: "user", state: "disabled", hashState: "new" });
    await expect(reviewRuntimeHookTrust(manager, { sourceId: "user", fileName: row.fileName, expectedSha256: "stale", action: "accept" }))
      .resolves.toMatchObject({ ok: false, error: "hook-review-stale" });
    expect(existsSync(join(layout.disabledDir, row.fileName))).toBe(true);
    expect((await reviewRuntimeHookTrust(manager, { sourceId: "user", fileName: row.fileName, expectedSha256: row.sha256, action: "accept" })).ok).toBe(true);
    expect(manager.hooksOfType("pre")).toHaveLength(1);
    const generation = manager.getGeneration();
    expect(manager.hooksOfType("pre")).toHaveLength(1);
    expect(manager.getGeneration()).toBe(generation);
    writeExecutableHook(layout.hooksDir, "pre-review.sh", "#!/bin/sh\necho changed\n");
    expect(manager.hooksOfType("pre")).toHaveLength(0);
    row = listRuntimeHookTrustState(manager).disabled[0];
    expect(row).toMatchObject({ hashState: "changed" });
    expect(row.previousSha256).toBeTruthy();
    const restarted = await wireHookSystem({ ...layout, policy: openPolicy() });
    expect(listRuntimeHookTrustState(restarted.manager).disabled[0].hashState).toBe("changed");
  });

  it("keeps same-named system and user trust separate in one lockfile", async () => {
    const layout = hookDirLayout(root);
    const systemDir = join(root, "system-hooks");
    writeExecutableHook(layout.hooksDir, "pre-common.sh");
    writeExecutableHook(systemDir, "pre-common.sh", "#!/bin/sh\nexit 0\n");
    const { manager } = await wireHookSystem({ ...layout, systemHooksDir: systemDir, policy: openPolicy() });
    const rows = listRuntimeHookTrustState(manager).disabled;
    expect(rows.map((row) => row.sourceId).sort()).toEqual(["system", "user"]);
    for (const row of rows) expect((await reviewRuntimeHookTrust(manager, { sourceId: row.sourceId ?? "user", fileName: row.fileName, expectedSha256: row.sha256, action: "accept" })).ok).toBe(true);
    expect(readLockfile(layout.lockfilePath)?.hooks).toHaveLength(2);
    expect(manager.hooksOfType("pre")).toHaveLength(2);
    const user = listRuntimeHookTrustState(manager).active.find((row) => row.sourceId === "user");
    if (!user) throw new Error("User hook row missing");
    await reviewRuntimeHookTrust(manager, { sourceId: "user", fileName: user.fileName, expectedSha256: user.sha256, action: "disable" });
    expect(manager.hooksOfType("pre")).toHaveLength(1);
    expect(listRuntimeHookTrustState(manager).active[0].sourceId).toBe("system");
  });

  it("reads and runs no project hook while the project's workspace gate refuses", async () => {
    const layout = hookDirLayout(root);
    const project = join(root, "project");
    writeExecutableHook(join(project, ".ave", "hooks"), "pre-project.sh");
    const { manager } = await wireHookSystem({ ...layout, policy: openPolicy() });
    const projectRows = () => {
      const state = listRuntimeHookTrustState(manager, project);
      return [...state.active, ...state.disabled].filter((entry) => entry.hookSource === "project");
    };
    const [row] = projectRows();
    if (!row) throw new Error("Project hook row missing");
    const request = { sourceId: row.sourceId ?? "project", fileName: row.fileName, expectedSha256: row.sha256 };
    const payload = { toolName: "read_file", source: "builtin" as const, category: "read" as const, input: {}, sessionId: "project", trustOrigin: "user-keyboard" as const };
    const gate = vi.spyOn(hostWorkspaceGate, "isHostWorkspaceConsumable").mockReturnValue(false);
    try {
      expect(projectRows()).toEqual([]);
      expect((await reviewRuntimeHookTrust(manager, { ...request, action: "trust-project" }, project)).ok).toBe(false);
    } finally {
      gate.mockRestore();
    }
    expect((await reviewRuntimeHookTrust(manager, { ...request, action: "trust-project" }, project)).ok).toBe(true);
    expect((await reviewRuntimeHookTrust(manager, { ...request, action: "accept" }, project)).ok).toBe(true);
    expect((await manager.runPreToolUse(payload, { cwd: project })).results).toHaveLength(1);
    // A trusted, accepted project hook is skipped as well, and comes back once the gate passes.
    const refusedAgain = vi.spyOn(hostWorkspaceGate, "isHostWorkspaceConsumable").mockReturnValue(false);
    try {
      expect((await manager.runPreToolUse(payload, { cwd: project })).results).toHaveLength(0);
    } finally {
      refusedAgain.mockRestore();
    }
    expect((await manager.runPreToolUse(payload, { cwd: project })).results).toHaveLength(1);
  });

  it("requires project trust before definition enrollment and scopes dispatch to its root", async () => {
    const layout = hookDirLayout(root);
    const project = join(root, "project");
    const projectHooks = join(project, ".ave", "hooks");
    writeExecutableHook(projectHooks, "pre-project.sh");
    const { manager } = await wireHookSystem({ ...layout, policy: openPolicy() });
    const row = listRuntimeHookTrustState(manager, project).active.find((entry) => entry.hookSource === "project");
    if (!row) throw new Error("Project hook row missing");
    expect(row.projectTrusted).toBe(false);
    const request = { sourceId: row.sourceId ?? "project", fileName: row.fileName, expectedSha256: row.sha256 };
    await expect(reviewRuntimeHookTrust(manager, { ...request, action: "accept" }, project)).resolves.toMatchObject({ ok: false, error: "hook-project-untrusted" });
    expect((await reviewRuntimeHookTrust(manager, { ...request, action: "trust-project" }, project)).ok).toBe(true);
    expect((await reviewRuntimeHookTrust(manager, { ...request, action: "accept" }, project)).ok).toBe(true);
    expect(readLockfile(layout.lockfilePath)?.trustedProjects).toEqual([project]);
    expect(manager.hooksOfType("pre")).toHaveLength(0);
    const payload = { toolName: "read_file", source: "builtin" as const, category: "read" as const, input: {}, sessionId: "project", trustOrigin: "user-keyboard" as const };
    expect((await manager.runPreToolUse(payload, { cwd: root })).results).toHaveLength(0);
    expect((await manager.runPreToolUse(payload, { cwd: project })).results).toHaveLength(1);
    const otherProject = join(root, "other-project");
    mkdirSync(otherProject);
    expect(listRuntimeHookTrustState(manager, otherProject).active.some((entry) => entry.sourceId === row.sourceId)).toBe(false);
    await expect(reviewRuntimeHookTrust(manager, { ...request, action: "disable" }, otherProject))
      .resolves.toMatchObject({ ok: false, error: "hook-review-stale" });
  });

  it("binds relative script hashes and execution argv to the configuration directory", async () => {
    const layout = hookDirLayout(root);
    mkdirSync(layout.hooksDir, { recursive: true });
    writeFileSync(join(layout.hooksDir, "policy.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(layout.hooksDir, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["./policy.sh"] }] }] } }));
    const { manager } = await wireHookSystem({ ...layout, policy: openPolicy() });
    const row = listRuntimeHookTrustState(manager).disabled[0];
    expect((await reviewRuntimeHookTrust(manager, { sourceId: "user", fileName: row.fileName, expectedSha256: row.sha256, action: "accept" })).ok).toBe(true);
    expect(manager.hooksOfType("pre")[0].command).toEqual([join(layout.hooksDir, "policy.sh")]);
    expect(loadHookConfig(join(layout.hooksDir, "hooks.json")).trustHash).toBe(row.sha256);
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "policy.sh"), "#!/bin/sh\nexit 99\n");
    expect(manager.hooksOfType("pre")[0].command).toEqual([join(layout.hooksDir, "policy.sh")]);
    writeFileSync(join(layout.hooksDir, "policy.sh"), "#!/bin/sh\nexit 1\n");
    expect(manager.hooksOfType("pre")).toHaveLength(0);
  });

  it("revokes a reviewed invocation when a script after its absolute interpreter changes", async () => {
    const layout = hookDirLayout(root);
    mkdirSync(layout.hooksDir, { recursive: true });
    const first = join(layout.hooksDir, "first.cjs");
    const second = join(layout.hooksDir, "second.cjs");
    writeFileSync(first, "first reviewed");
    writeFileSync(second, "second reviewed");
    const option = `--output=${join(root, "result.json")}`;
    writeFileSync(join(layout.hooksDir, "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{
      type: "command", command: [process.execPath, "./first.cjs", "./second.cjs", option],
    }] }] } }));
    const { manager } = await wireHookSystem({ ...layout, policy: openPolicy() });
    const row = listRuntimeHookTrustState(manager).disabled[0];
    expect((await reviewRuntimeHookTrust(manager, { sourceId: "user", fileName: row.fileName,
      expectedSha256: row.sha256, action: "accept" })).ok).toBe(true);
    const admitted = manager.hooksOfType("pre")[0];
    expect(admitted.command).toEqual([process.execPath, "./first.cjs", "./second.cjs", option]);
    expect(admitted.validateTrust?.()).toBe(true);
    writeFileSync(second, "second changed");
    expect(admitted.validateTrust?.()).toBe(false);
    expect(manager.hooksOfType("pre")).toEqual([]);
    expect(listRuntimeHookTrustState(manager).disabled[0].hashState).toBe("changed");
  });
});

describe("administrator hook authority", () => {
  it("binds a managed relative script to the administrator configuration directory", async () => {
    injectAdministratorFacts();
    const adminDir = join(root, "admin");
    mkdirSync(adminDir);
    writeFileSync(join(adminDir, "policy.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(adminDir, "policy.json"), JSON.stringify({ version: 1,
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: ["./policy.sh"] }] }] } }));
    const policy = await loadHookRuntimePolicy(join(adminDir, "policy.json"));
    const hostileCwd = join(root, "hostile");
    mkdirSync(hostileCwd);
    writeFileSync(join(hostileCwd, "policy.sh"), "#!/bin/sh\nexit 99\n");
    expect(policy.managedHooks[0].command).toEqual([join(adminDir, "policy.sh")]);
    expect(policy.managedHooks[0].validateTrust?.()).toBe(true);
    writeFileSync(join(adminDir, "policy.sh"), "#!/bin/sh\nexit 1\n");
    expect(policy.managedHooks[0].validateTrust?.()).toBe(false);
    writeFileSync(join(adminDir, "policy.sh"), "#!/bin/sh\nexit 0\n");
    expect(policy.managedHooks[0].validateTrust?.()).toBe(true);
    writeFileSync(join(adminDir, "policy.json"), JSON.stringify({ version: 1 }));
    expect(policy.managedHooks[0].validateTrust?.()).toBe(false);
  });

  it("refuses an administrator definition with an unreadable file operand", async () => {
    injectAdministratorFacts();
    const adminDir = join(root, "admin");
    mkdirSync(adminDir);
    const adminPath = join(adminDir, "policy.json");
    const withOperand = (operand: string) => JSON.stringify({ version: 1, hooks: { PreToolUse: [{ hooks: [{
      type: "command", command: [process.execPath, operand],
    }] }] } });
    writeFileSync(join(adminDir, "readable.cjs"), "");
    writeFileSync(adminPath, withOperand("./readable.cjs"));
    expect(await loadHookRuntimePolicy(adminPath)).toMatchObject({ allowManagedHooksOnly: false, managedHooks: [{ hookSource: "managed" }] });
    symlinkSync("loop.cjs", join(adminDir, "loop.cjs"));
    writeFileSync(adminPath, withOperand("./loop.cjs"));
    expect(await loadHookRuntimePolicy(adminPath)).toMatchObject({ allowManagedHooksOnly: true, managedHooks: [] });
  });

  it("applies user disable-all to reviewed hooks while retaining managed execution", async () => {
    const layout = hookDirLayout(root);
    writeExecutableHook(layout.hooksDir, "pre-user.sh");
    const managed = { id: "managed-pre", event: "pre" as const, command: ["/usr/bin/true"], timeoutMs: 5000, source: "config" as const, hookSource: "managed" as const };
    const { manager } = await wireHookSystem({ ...layout, policy: { ...openPolicy(), managedHooks: [managed] } });
    await acceptHookTrust("pre-user.sh", { ...layout, manager });
    expect(manager.hooksOfType("pre")).toHaveLength(2);
    writeFileSync(join(layout.hooksDir, "hooks.json"), JSON.stringify({ disableAllHooks: true }));
    expect(manager.hooksOfType("pre")).toHaveLength(1);
    expect(manager.hooksOfType("pre")).toHaveLength(1);
    expect(manager.hooksOfType("pre")[0].hookSource).toBe("managed");
  });

  it("loads managed definitions and network exceptions only from the administrator source", async () => {
    injectAdministratorFacts();
    const admin = join(root, "policy.json");
    // The managed command is a hashed file anchor, so it must exist on every host.
    const anchor = join(root, "managed.sh");
    writeFileSync(anchor, "#!/bin/sh\nexit 0\n");
    writeFileSync(admin, JSON.stringify({ version: 1, allowManagedHooksOnly: true,
      allowedHttpHookUrls: ["https://hooks.example.test"], httpHookAllowedEnvVars: ["HOOK_TOKEN", "bad-name"],
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: [anchor] }] }] } }));
    const policy = await loadHookRuntimePolicy(admin);
    expect(policy).toMatchObject({ allowManagedHooksOnly: true, allowedHttpHookUrls: ["https://hooks.example.test"], httpHookAllowedEnvVars: ["HOOK_TOKEN"] });
    expect(policy.managedHooks[0].hookSource).toBe("managed");
    const layout = hookDirLayout(root);
    writeExecutableHook(layout.hooksDir, "pre-user.sh");
    const { manager } = await wireHookSystem({ ...layout, policy });
    expect(manager.hooksOfType("pre")).toHaveLength(1);
    const row = listRuntimeHookTrustState(manager).active[0];
    expect(row).toMatchObject({ sourceId: "managed", state: "managed" });
    await expect(reviewRuntimeHookTrust(manager, { sourceId: "managed", fileName: row.fileName, expectedSha256: row.sha256, action: "disable" }))
      .resolves.toMatchObject({ ok: false, error: "managed-hook-policy" });
    mkdirSync(layout.hooksDir, { recursive: true });
    writeFileSync(join(layout.hooksDir, "hooks.json"), JSON.stringify({ disableAllHooks: true }));
    expect(manager.hooksOfType("pre")).toHaveLength(1);
  });

  it("fails closed on a malformed administrator policy or unknown hook definition", async () => {
    injectAdministratorFacts();
    const admin = join(root, "policy.json");
    writeFileSync(admin, JSON.stringify({ version: 1, allowManagedHooksOnly: false, allowedHttpHookUrls: ["https://hooks.example.test"] }));
    expect(await loadHookRuntimePolicy(admin)).toMatchObject({ allowManagedHooksOnly: false, allowedHttpHookUrls: ["https://hooks.example.test"] });
    writeFileSync(admin, "invalid");
    expect(await loadHookRuntimePolicy(admin)).toMatchObject({ allowManagedHooksOnly: true, managedHooks: [], allowedHttpHookUrls: [] });
    writeFileSync(admin, JSON.stringify({ version: 1, allowManagedHooksOnly: false,
      hooks: { PreToolUse: [{ hooks: [{ type: "unrecognized", secret: "not-for-diagnostics" }] }] } }));
    expect(await loadHookRuntimePolicy(admin)).toMatchObject({ allowManagedHooksOnly: true, managedHooks: [], allowedHttpHookUrls: [] });
  });

  it.runIf(process.platform === "win32")("refuses an administrator policy whose owner or DACL is an ordinary principal's", async () => {
    const admin = join(root, "policy.json");
    writeFileSync(admin, JSON.stringify({ version: 1, allowManagedHooksOnly: false, allowedHttpHookUrls: ["https://hooks.example.test"] }));
    const closed = { allowManagedHooksOnly: true, allowedHttpHookUrls: [] };
    const cases: [InjectedSecurity, InjectedSecurity][] = [
      [{ owner: ORDINARY_USER, writer: ADMINISTRATORS }, administratorOnly],
      [{ owner: ADMINISTRATORS, writer: ORDINARY_USER }, administratorOnly],
      [administratorOnly, { owner: ORDINARY_USER, writer: ADMINISTRATORS }],
      [administratorOnly, { owner: ADMINISTRATORS, writer: ORDINARY_USER }],
    ];
    for (const [file, parent] of cases) {
      injected.file = file;
      injected.parent = parent;
      expect(await loadHookRuntimePolicy(admin)).toMatchObject(closed);
    }
    injectAdministratorFacts();
    expect(await loadHookRuntimePolicy(admin)).toMatchObject({ allowManagedHooksOnly: false, allowedHttpHookUrls: ["https://hooks.example.test"] });
  });

  it.runIf(process.platform === "win32")("trusts a real policy file exactly when its native owner and DACL pass the administrator check", async () => {
    const admin = join(root, "policy.json");
    writeFileSync(admin, JSON.stringify({ version: 1, allowManagedHooksOnly: false, allowedHttpHookUrls: ["https://hooks.example.test"] }));
    const [row] = readWindowsDacls([admin], { parent: true });
    if (!row?.dacl || !row.parent) throw new Error("Policy snapshot missing");
    const failure = windowsPolicyTrustFailure(windowsPolicyDescriptor(row.dacl), windowsPolicyDescriptor(row.parent));
    expect(await loadHookRuntimePolicy(admin)).toMatchObject(failure === null
      ? { allowManagedHooksOnly: false, allowedHttpHookUrls: ["https://hooks.example.test"] }
      : { allowManagedHooksOnly: true, allowedHttpHookUrls: [] });
  });

  it("fails closed on an unreadable administrator policy and opens only on confirmed absence", async () => {
    mkdirSync(join(root, "directory-policy"));
    expect(await loadHookRuntimePolicy(join(root, "directory-policy"))).toMatchObject({ allowManagedHooksOnly: true, managedHooks: [] });
    expect(await loadHookRuntimePolicy(join(root, "absent-policy"))).toMatchObject({ allowManagedHooksOnly: false, managedHooks: [] });
  });
});
