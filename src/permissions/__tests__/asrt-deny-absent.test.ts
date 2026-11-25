import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as runtime from "@anthropic-ai/sandbox-runtime";
import * as sandboxUtils from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import * as windowsHelpers from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { afterQueuedCallbacks, deferred } from "../../__tests__/support/deferred.js";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { configureHostResources } from "../../main/host-resources.js";
import * as evidence from "../../shared/windows-read-deny-evidence.js";
import * as srtWinIntegrity from "../srt-win-integrity.js";
import * as denyAcl from "../windows-deny-acl.js";
import { registerWorkspaceDirectorySource } from "../workspace-authorized-roots.js";
import {
  buildPerCommandSandboxCustomConfig, buildSandboxConfig, grantWindowsWorkerFilesystemAccess,
  initializeAsrtSandbox, isAsrtSandboxActive, registerWorkerUnixSocketDir,
  resetAsrtSandbox, unregisterWorkerUnixSocketDir, wrapTerminalCommand, wrapToolCommand, wrapWorkerCommand,
} from "../asrt-sandbox.js";
import { resetWatchedRows, watchedProtectedRows } from "../windows-watched-rows.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});
vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js", async importOriginal => ({
  ...(await importOriginal<typeof windowsHelpers>()),
  stampWindowsAclAsync: vi.fn(),
}));

vi.mock("@anthropic-ai/sandbox-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/sandbox-runtime")>()),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
}));

vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js")>()),
}));

useVerifiedAveHomePrivacy();

function writeFixtureWindowsAdapter(root: string, srtWin: { exe: string; prependArgs: string[] }): string {
  const require = createRequire(import.meta.url);
  const helperPath = require.resolve("@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js");
  const pure = new Set(["parseWindowsBinShell", "expandWindowsFsPaths", "rankWindowsFsAccess", "parseWindowsSandboxError",
    "windowsInstallInstructions", "windowsStateDir", "setWindowsAclRecoveryListener", "expandWindowsAclDenyLists", "assertWindowsAclPolicyBudget",
    "assertWindowsEntriesAdmitted"]);
  const substitutes: Record<string, string> = {
    resolveSrtWin: "() => fixture",
    checkWindowsDependenciesAsync: "() => Promise.resolve({ errors: [], warnings: [] })",
    getWindowsSandboxUserStatusAsync: '() => Promise.resolve({ provisioned: true, credPresent: true, sid: "S-1-5-21-1001" })',
    verifyWindowsWfpEgress: "() => Promise.resolve()",
  };
  const adapter = join(root, "windows-adapter.mjs");
  writeFileSync(adapter, [
    'import { createRequire } from "node:module";',
    // Load the real helpers even when the worker stamp is mocked in this suite.
    `const actual = createRequire(import.meta.url)(${JSON.stringify(helperPath)});`,
    `const fixture = ${JSON.stringify(srtWin)};`,
    'function guard(args) { if (!args.some(arg => arg?.srtWin?.exe === fixture.exe && JSON.stringify(arg.srtWin.prependArgs) === JSON.stringify(fixture.prependArgs))) throw new Error("Fixture srtWin required"); }',
    ...Object.entries(windowsHelpers).map(([name, value]) => {
      const implementation = substitutes[name] ?? `actual.${name}`;
      return typeof value !== "function" ? `export const ${name} = actual.${name};`
        : pure.has(name) || name === "resolveSrtWin" ? `export const ${name} = ${implementation};`
        : `export const ${name} = (...args) => { guard(args); return (${implementation})(...args); };`;
    }),
  ].join("\n"));
  return adapter;
}

it.each(["expandWindowsAclDenyLists", "assertWindowsAclPolicyBudget"] as const)("runs %s without a fixture executable", async name => {
  const root = mkdtempSync(join(os.tmpdir(), "acl-policy-adapter-"));
  try {
    const srtWin = { exe: process.execPath, prependArgs: [join(root, "unused.mjs")] };
    const adapter = await import(/* @vite-ignore */ pathToFileURL(writeFixtureWindowsAdapter(root, srtWin)).href) as typeof windowsHelpers;
    const target = join(root, "absent-control");
    const expected = name === "expandWindowsAclDenyLists"
      ? { denyRead: [], denyWrite: windowsHelpers.expandWindowsFsPaths([target], { mode: "deny" }), credentialDeny: [], admitted: [] }
      : undefined;
    expect(Reflect.get(adapter, name)([], [target])).toEqual(expected);
    expect(() => adapter.stampWindowsAcl({ sandboxUserSid: "S-1-5-21-1001", denyRead: [], denyWrite: [target] }))
      .toThrow("Fixture srtWin required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("runs both recovery APIs through the guarded fixture executable", async () => {
  const root = mkdtempSync(join(os.tmpdir(), "acl-recovery-adapter-"));
  try {
    const script = join(root, "recovery.mjs");
    const calls = join(root, "recovery-calls.jsonl");
    writeFileSync(script, [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
      'process.stdout.write(JSON.stringify({ deadBrokers: 1, acesRevoked: 2 }));',
    ].join("\n"));
    const srtWin = { exe: process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, prependArgs: [script] };
    const adapter = await import(/* @vite-ignore */ pathToFileURL(writeFixtureWindowsAdapter(root, srtWin)).href) as typeof windowsHelpers;
    expect(adapter.recoverWindowsAcl({ srtWin })).toEqual({ deadBrokers: 1, acesRevoked: 2 });
    await expect(adapter.recoverWindowsAclAsync({ srtWin })).resolves.toEqual({ deadBrokers: 1, acesRevoked: 2 });
    expect(readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)))
      .toEqual([["acl", "recover", "--json"], ["acl", "recover", "--json"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === "win32")("Windows deny target handoff", () => {
  let root: string;
  let profile: string;
  let config: SandboxRuntimeConfig | undefined;
  const manager = runtime.SandboxManager;

  beforeEach(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    root = mkdtempSync(join(os.tmpdir(), "deny-absent-"));
    profile = join(root, "alice");
    mkdirSync(profile);
    vi.stubEnv("HOME", profile);
    vi.stubEnv("USERPROFILE", profile);
    vi.spyOn(os, "homedir").mockReturnValue(profile);
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: profile });
    vi.spyOn(srtWinIntegrity, "prepareSrtWinExecutable").mockImplementation(source => source);
    // This spy reaches windows-stamp-targets.ts only; asrt-sandbox.ts expands through the spied os.homedir above.
    const expand = sandboxUtils.expandWindowsEnvRefs;
    const runtimeHome = expand("%USERPROFILE%");
    vi.spyOn(sandboxUtils, "expandWindowsEnvRefs").mockImplementation(path => expand(path).replace(runtimeHome, profile));
    vi.spyOn(evidence, "readWindowsReadDenyEvidence").mockImplementation(async paths =>
      new Map(paths.map(path => [evidence.windowsReadDenyKey(path), { status: "error" as const, reason: "probe failed" }])));
    config = undefined;
    vi.spyOn(runtime, "getWindowsSandboxUserStatus").mockReturnValue({
      provisioned: true, credPresent: true, sid: "S-1-5-21-1001",
    } as ReturnType<typeof runtime.getWindowsSandboxUserStatus>);
    vi.spyOn(runtime, "grantWindowsAcl").mockImplementation(() => {});
    vi.spyOn(runtime, "revokeWindowsAcl").mockImplementation(({ holderPid }) =>
      vi.mocked(runtime.grantWindowsAcl).mock.calls.filter(([call]) => call.holderPid === holderPid)
        .flatMap(([call]) => (call.read ?? []).map(path => ({ path, status: "revoked" as const }))));
    vi.spyOn(runtime, "stampWindowsAcl").mockImplementation(() => {});
    vi.mocked(windowsHelpers.stampWindowsAclAsync).mockReset().mockResolvedValue(undefined);
    vi.spyOn(runtime, "restoreWindowsAcl").mockReturnValue([]);
    vi.spyOn(denyAcl, "readWindowsDenyAcls").mockImplementation(paths => paths.map(() => ({
      denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: denyAcl.WINDOWS_READ_DENY_MASK,
      parentMask: 0x40, directory: false,
    })));
  });

  afterEach(async () => {
    try {
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
    } finally {
      resetWatchedRows();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Stamp-turn fixtures need a present target: an absent row is watched, never stamped.
  function present(path: string): string {
    writeFileSync(path, "");
    return path;
  }

  function captureRuntime() {
    vi.spyOn(manager, "initialize").mockImplementation(async next => { config = next; });
    vi.spyOn(manager, "getConfig").mockImplementation(() => config);
    vi.spyOn(manager, "updateConfig").mockImplementation(next => { config = next; });
    vi.spyOn(manager, "reset").mockImplementation(async () => { config = undefined; return { windowsAclUnreleased: [] }; });
    return vi.spyOn(manager, "wrapWithSandboxArgv").mockResolvedValue({ argv: ["echo"], env: {} });
  }

  function nativeDenySpelling(path: string): string {
    return /^[A-Za-z]:[\\/]/u.test(path) ? path.replace(/[\\/]/gu, sep) : path;
  }

  function stampedPaths(): string[] {
    return vi.mocked(windowsHelpers.stampWindowsAclAsync).mock.calls.flatMap(([call]) => [...(call.denyRead ?? []), ...(call.denyWrite ?? [])]);
  }

  function paths(entries: readonly runtime.FilesystemPathEntry[] | undefined): string[] {
    return (entries ?? []).map(entry => nativeDenySpelling(typeof entry === "string" ? entry : entry.path).replace(/[\\/]+$/, ""));
  }

  it("rejects runtime helpers that omit the fixture or resolve a bundled executable", async () => {
    const srtWin = { exe: process.execPath, prependArgs: [join(root, "fixture.mjs")] };
    const adapter = await import(/* @vite-ignore */ pathToFileURL(writeFixtureWindowsAdapter(root, srtWin)).href);
    for (const name of ["getWindowsSandboxUserStatusAsync", "stampWindowsAcl", "restoreWindowsAcl", "grantWindowsAcl", "revokeWindowsAcl", "getSrtWinPath"]) {
      expect(() => adapter[name]({})).toThrow("Fixture srtWin required");
      expect(() => adapter[name]({ srtWin: { exe: "bundled/srt-win.exe", prependArgs: [] } })).toThrow("Fixture srtWin required");
    }
    await expect(adapter.getWindowsSandboxUserStatusAsync({ srtWin })).resolves.toMatchObject({ provisioned: true });
  });

  it("ledgers and releases account-profile denies while the application home is isolated", async () => {
    const account = join(root, "bob");
    const target = join(account, ".config", "ave", "hooks");
    mkdirSync(target, { recursive: true });
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: account });
    expect(process.env.AVE_HOME?.startsWith(account)).toBe(false);
    const ledger = join(root, "held-rows.json");
    const calls = join(root, "release-calls.json");
    const script = join(root, "acl-ledger.mjs");
    writeFileSync(script, [
      'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
      `const ledger = ${JSON.stringify(ledger)};`,
      `const calls = ${JSON.stringify(calls)};`,
      'const command = process.argv[3];',
      'const holder = process.argv.includes("--holder-pid") ? process.argv[process.argv.indexOf("--holder-pid") + 1] : undefined;',
      'const filter = process.argv.includes("--path") ? process.argv[process.argv.indexOf("--path") + 1] : undefined;',
      'let rows = existsSync(ledger) ? JSON.parse(readFileSync(ledger, "utf8")) : [];',
      'const history = existsSync(calls) ? JSON.parse(readFileSync(calls, "utf8")) : [];',
      'history.push({ command, holder }); writeFileSync(calls, JSON.stringify(history));',
      'if (command === "recover") { process.stdout.write(JSON.stringify({ deadBrokers: 0, acesRevoked: 0 })); process.exit(0); }',
      'let outcomes = [];',
      'if (command === "stamp") {',
      '  const input = JSON.parse(readFileSync(0, "utf8"));',
      `  rows = input.denyRead.map(path => path.replace(/[\\\\/]+$/, "")).filter(path => path === ${JSON.stringify(target)}).flatMap(path => [{ path, holder, kind: "deny-read" }, { path: ${JSON.stringify(dirname(target))}, holder, kind: "deny-delete-child" }]);`,
      '} else if (command === "restore") {',
      '  const selected = row => row.holder === holder && (!filter || row.path === filter || row.path.startsWith(filter + "\\\\"));',
      '  outcomes = rows.filter(selected).map(row => ({ path: row.path, status: "revoked" }));',
      '  rows = rows.filter(row => !selected(row));',
      '}',
      'writeFileSync(ledger, JSON.stringify(rows));',
      'process.stdout.write(JSON.stringify(outcomes));',
    ].join("\n"));
    const srtWin = { exe: process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, prependArgs: [script] };
    // Run the isolated manager with the guarded helper adapter so its ACL calls use the fixture executable.
    const require = createRequire(import.meta.url);
    const managerUrl = pathToFileURL(require.resolve("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js"));
    const adapter = writeFixtureWindowsAdapter(root, srtWin);
    const isolated = join(root, "sandbox-manager.mjs");
    writeFileSync(isolated, readFileSync(managerUrl, "utf8").replace(/from '(\.[^']+)'/g, (_, specifier: string) =>
      `from ${JSON.stringify(specifier === "./windows-sandbox-utils.js" ? pathToFileURL(adapter).href : new URL(specifier, managerUrl).href)}`));
    const { SandboxManager: isolatedManager } = await import(/* @vite-ignore */ pathToFileURL(isolated).href) as typeof import("@anthropic-ai/sandbox-runtime");
    vi.spyOn(manager, "initialize").mockImplementation(async next => {
      config = next;
      await isolatedManager.initialize({ ...next, network: { ...next.network, httpProxyPort: 18080, socksProxyPort: 18081 } });
    });
    vi.spyOn(manager, "reset").mockImplementation(() => isolatedManager.reset());
    try {
      await initializeAsrtSandbox({});
      expect(paths(config?.filesystem.denyRead)).toContain(target);
      expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual([
        { path: target, holder: String(process.pid), kind: "deny-read" },
        { path: dirname(target), holder: String(process.pid), kind: "deny-delete-child" },
      ]);
    } finally {
      // Failed initialization already awaits the same runtime reset.
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
    }
    expect(JSON.parse(readFileSync(ledger, "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(calls, "utf8"))).toEqual([
      { command: "recover" },
      ...["stamp", "revoke", "restore"].map(command => ({ command, holder: String(process.pid) })),
    ]);
  });

  it("preserves machine read protection when a parent receives a write grant", async () => {
    captureRuntime();
    const machine = join(root, "machine");
    const grant = join(machine, "Ave");
    mkdirSync(grant, { recursive: true });
    vi.stubEnv("ProgramData", machine);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(windowsHelpers.stampWindowsAclAsync).toHaveBeenCalledWith(expect.objectContaining({
        denyRead: expect.arrayContaining([target]), denyWrite: expect.arrayContaining([target]),
      }));
    } finally { held.release(); }
  });

  it("refuses a write envelope containing an initially unmatched deny glob", async () => {
    captureRuntime();
    const grant = join(root, "workspace");
    mkdirSync(grant);
    const pattern = join(grant, "*.secret");
    await initializeAsrtSandbox({ denyRead: [pattern], denyWrite: [pattern] });
    writeFileSync(join(grant, "new.secret"), "secret");
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow(/glob/i);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("includes wrap-only machine read rows in native protection before granting writes", async () => {
    captureRuntime();
    const machine = join(root, "machine");
    const grant = join(machine, "Ave");
    mkdirSync(grant, { recursive: true });
    vi.stubEnv("ProgramData", machine);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({});
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [target] } });
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(windowsHelpers.stampWindowsAclAsync).toHaveBeenCalledWith(expect.objectContaining({ denyRead: expect.arrayContaining([target]) }));
    } finally { held.release(); }
  });

  it("hands only the admitted deny target to the worker ACL transaction", async () => {
    captureRuntime();
    const grant = join(root, "workspace");
    const target = join(grant, "secret");
    const raw = `${grant}\\nested\\..\\secret`;
    mkdirSync(join(grant, "nested"), { recursive: true });
    writeFileSync(target, "fixture");
    await initializeAsrtSandbox({ denyRead: [raw] });

    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(denyAcl.readWindowsDenyAcls).toHaveBeenCalledWith([target], expect.any(String));
      expect(windowsHelpers.stampWindowsAclAsync).toHaveBeenCalledWith(expect.objectContaining({
        denyRead: [target], denyWrite: [target],
      }));
    } finally { held.release(); }
  });

  it("refuses a successful stamp that leaves a target unprotected", async () => {
    captureRuntime();
    const grant = join(root, "unverifiable");
    mkdirSync(grant);
    const target = present(join(grant, "secret"));
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => paths.map(() => ({
      denyMask: 0, inheritableMask: 0, parentMask: 0, directory: false,
    })));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow(/verif|DACL/i);
    expect(windowsHelpers.stampWindowsAclAsync).toHaveBeenCalled();
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(isAsrtSandboxActive()).toBe(true);
    await expect(wrapToolCommand("echo refused", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/reset the sandbox session/);
    await expect(wrapWorkerCommand("echo refused", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/reset the sandbox session/);
  });

  it("unions native read protection with a write-only policy row", async () => {
    captureRuntime();
    const grant = join(root, "native-union");
    mkdirSync(grant);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyWrite: [target] });
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(windowsHelpers.stampWindowsAclAsync).toHaveBeenCalledWith(expect.objectContaining({ denyRead: expect.arrayContaining([target]) }));
      expect(denyAcl.readWindowsDenyAcls).toHaveBeenCalledTimes(2);
      expect(vi.mocked(denyAcl.readWindowsDenyAcls).mock.invocationCallOrder[1])
        .toBeLessThan(vi.mocked(runtime.grantWindowsAcl).mock.invocationCallOrder[0]!);
    } finally { held.release(); }
  });

  it("runs concurrent grants one read-stamp-verify turn at a time", async () => {
    captureRuntime();
    const grant = join(root, "concurrent");
    mkdirSync(grant);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    const order: string[] = [];
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => {
      order.push("read");
      return paths.map(() => ({
        denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: denyAcl.WINDOWS_READ_DENY_MASK, parentMask: 0x40, directory: false,
      }));
    });
    vi.mocked(windowsHelpers.stampWindowsAclAsync).mockImplementation(async () => { order.push("stamp"); });
    vi.mocked(runtime.grantWindowsAcl).mockImplementation(() => { order.push("grant"); });
    const held = await Promise.all([1, 2].map(offset =>
      grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + offset, allowWrite: [grant] })));
    try {
      expect(order).toEqual(["read", "stamp", "read", "grant", "read", "stamp", "read", "grant"]);
    } finally { for (const entry of held) entry.release(); }
  });

  it("services an immediate during a delayed stamp and verifies before permitting spawn", async () => {
    captureRuntime();
    const workspace = join(root, "delayed-stamp");
    mkdirSync(workspace);
    await initializeAsrtSandbox({ denyRead: [present(join(workspace, "secret"))] });
    const entered = deferred<void>();
    const finishStamp = deferred<void>();
    const spawn = vi.fn();
    vi.mocked(windowsHelpers.stampWindowsAclAsync).mockImplementationOnce(() => {
      entered.resolve();
      return finishStamp.promise;
    });
    const spawning = grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [workspace] })
      .then(held => { spawn(); return held; });
    try {
      expect(await Promise.race([entered.promise.then(() => "stamping"), spawning.then(() => "settled")])).toBe("stamping");
      await afterQueuedCallbacks();
      expect(denyAcl.readWindowsDenyAcls).toHaveBeenCalledTimes(1);
      expect(runtime.stampWindowsAcl).not.toHaveBeenCalled();
      expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      spawn.mockImplementation(() => {
        expect(denyAcl.readWindowsDenyAcls).toHaveBeenCalledTimes(2);
        expect(runtime.grantWindowsAcl).toHaveBeenCalledOnce();
      });
    } finally {
      finishStamp.resolve();
      (await spawning).release();
    }
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("refuses a worker grant when a workspace root is added inside it during the stamp", async () => {
    captureRuntime();
    const directory = join(root, "directory-grant");
    const workspace = join(directory, "workspace");
    mkdirSync(workspace, { recursive: true });
    await initializeAsrtSandbox({ denyRead: [present(join(directory, "denied"))] });
    const source = {
      directories: [] as string[],
      getTurnAdditionalDirectories() { return this.directories; },
      getSessionExecutionCwd: () => root,
    };
    registerWorkspaceDirectorySource(source);
    const entered = deferred<void>();
    const finishStamp = deferred<void>();
    vi.mocked(windowsHelpers.stampWindowsAclAsync).mockImplementationOnce(() => {
      entered.resolve();
      return finishStamp.promise;
    });
    const holder = vi.fn(() => process.pid + 1);
    const spawn = vi.fn();
    const outcome = grantWindowsWorkerFilesystemAccess({ holderPid: holder, allowWrite: [directory] })
      .then(held => { spawn(); held.release(); });
    try {
      expect(await Promise.race([entered.promise.then(() => "stamping"), outcome.then(() => "settled")])).toBe("stamping");
      source.directories.push(workspace);
    } finally {
      finishStamp.resolve();
      await outcome.catch(() => {});
      source.directories.length = 0;
    }
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(holder).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    await expect(outcome).rejects.toThrow("Windows filesystem grant refuses an ancestor of the workspace or Ave home");
  });

  it.each([0, 2])("restores the session ACEs after a pending stamp exits with code %i", async (exitCode) => {
    captureRuntime();
    const workspace = join(root, "reset-stamp");
    const firstParent = join(workspace, "first-parent");
    mkdirSync(firstParent, { recursive: true });
    const first = present(join(firstParent, "first"));
    const second = present(join(workspace, "second"));
    const targets = [first, second];
    await initializeAsrtSandbox({ denyRead: targets });
    const initialAcls = new Map<string, denyAcl.WindowsDenyAcl>([
      [first, { denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: 0, parentMask: 0, directory: false }],
      [second, { denyMask: 0, inheritableMask: 0, parentMask: 0, directory: false }],
    ]);
    const nativeAcls = new Map(initialAcls);
    const ledger = new Map<string, denyAcl.WindowsDenyAcl>();
    const entered = deferred<void>();
    const finishStamp = deferred<void>();
    const readAcl = (path: string): denyAcl.WindowsDenyAcl => {
      const acl = nativeAcls.get(path);
      if (acl === undefined) throw new Error(`Unexpected ACL path: ${path}`);
      return acl;
    };
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => paths.map(readAcl));
    const stampedPaths: string[] = [];
    vi.mocked(windowsHelpers.stampWindowsAclAsync).mockImplementationOnce(async ({ denyWrite }) => {
      entered.resolve();
      await finishStamp.promise;
      const writes = [...(denyWrite ?? [])];
      stampedPaths.push(...(exitCode === 2 ? writes.slice(0, 1) : writes));
      for (const path of stampedPaths) {
        const original = readAcl(path);
        ledger.set(path, original);
        nativeAcls.set(path, { ...original, denyMask: denyAcl.WINDOWS_READ_DENY_MASK, parentMask: 0x40 });
      }
      if (exitCode === 2) throw new windowsHelpers.WindowsSandboxError("acl_stamp_failed", "Fixture stamp exited 2");
    });
    vi.mocked(manager.reset).mockImplementationOnce(async () => {
      for (const [path, original] of ledger) nativeAcls.set(path, original);
      ledger.clear();
      config = undefined;
      return { windowsAclUnreleased: [] };
    });
    const holder = vi.fn(() => process.pid + 1);
    const granting = grantWindowsWorkerFilesystemAccess({ holderPid: holder, allowWrite: [workspace] });
    const outcome = granting.then(held => { held.release(); return undefined; }, error => error);
    let resetting: Promise<void> | undefined;
    try {
      expect(await Promise.race([entered.promise.then(() => "stamping"), outcome.then(() => "settled")])).toBe("stamping");
      resetting = resetAsrtSandbox();
      await afterQueuedCallbacks();
      expect(isAsrtSandboxActive()).toBe(false);
    } finally {
      finishStamp.resolve();
      await outcome;
      await resetting;
    }
    expect(stampedPaths).toEqual(exitCode === 2 ? targets.slice(0, 1) : targets);
    expect(readAcl(first).parentMask).toBe(0);
    expect(nativeAcls).toEqual(initialAcls);
    expect(ledger.size).toBe(0);
    expect(await outcome).toMatchObject({
      message: exitCode === 2 ? "Windows deny DACL verification failed; reset the sandbox session" : "Windows sandbox session was reset",
    });
    expect(holder).not.toHaveBeenCalled();
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it.each([
    ["policy", "Windows deny obligations changed"],
    ["holder", "Windows ACL grant holder was revoked"],
    ["live grant", "Windows sandbox policy changed while stamping the worker grant"],
  ])("refuses a worker grant when the %s changes during the stamp", async (changed, message) => {
    captureRuntime();
    const workspace = join(root, "invalidated-stamp");
    mkdirSync(workspace);
    await initializeAsrtSandbox({ denyRead: [present(join(workspace, "secret"))] });
    const existing = changed === "live grant"
      ? await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 2, allowRead: [workspace] })
      : undefined;
    let revoked = false;
    vi.mocked(windowsHelpers.stampWindowsAclAsync).mockImplementationOnce(async () => {
      if (changed === "policy") {
        await wrapToolCommand("echo", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [join(root, "late")] } });
      } else if (changed === "holder") {
        revoked = true;
      } else {
        existing?.release();
      }
    });
    const holder = vi.fn(() => process.pid + 1);
    try {
      const outcome = await grantWindowsWorkerFilesystemAccess({
        holderPid: holder, allowWrite: [workspace],
        assertStillValid: () => { if (revoked) throw new Error("Windows ACL grant holder was revoked"); },
      }).then(held => { held.release(); return undefined; }, error => error);
      expect(outcome).toMatchObject({ message });
    } finally {
      existing?.release();
    }
    expect(holder).not.toHaveBeenCalled();
    expect(runtime.grantWindowsAcl).toHaveBeenCalledTimes(existing === undefined ? 0 : 1);
  });

  it.each(["literal", "glob"])("refuses a %s obligation registered during readback", async kind => {
    captureRuntime();
    const workspace = join(root, "late-obligation");
    mkdirSync(workspace);
    const initial = join(workspace, "initial");
    const late = join(workspace, kind === "glob" ? "*.secret" : "late-secret");
    await initializeAsrtSandbox({ denyRead: [initial] });
    const read = vi.mocked(denyAcl.readWindowsDenyAcls).getMockImplementation()!;
    let wrapping: Promise<void> | undefined;
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementationOnce(paths => {
      wrapping = expect(wrapToolCommand("echo late", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [late] } }))
        .resolves.toMatchObject({ argv: ["echo"] });
      return read(paths, "S-1-5-21-1001");
    });
    try {
      const grant = grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [workspace] })
        .then(held => { held.release(); return held; });
      await expect(grant).rejects.toThrow(/obligation|glob|changed/i);
      expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
      expect(wrapping).toBeDefined();
    } finally {
      await wrapping;
    }
  });

  it("does not yield between obligation readback and the native grant", async () => {
    captureRuntime();
    const workspace = join(root, "atomic-turn");
    mkdirSync(workspace);
    await initializeAsrtSandbox({ denyRead: [present(join(workspace, "secret"))] });
    const read = vi.mocked(denyAcl.readWindowsDenyAcls).getMockImplementation()!;
    let yielded = false;
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementationOnce(read).mockImplementationOnce(paths => {
      queueMicrotask(() => { yielded = true; });
      return read(paths, "S-1-5-21-1001");
    });
    vi.mocked(runtime.grantWindowsAcl).mockImplementation(() => { expect(yielded).toBe(false); });
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [workspace] });
    held.release();
    expect(yielded).toBe(true);
  });

  it("refuses a reset during final readback without publishing old grants", async () => {
    captureRuntime();
    const workspace = join(root, "reset-readback");
    mkdirSync(workspace);
    await initializeAsrtSandbox({ denyRead: [present(join(workspace, "secret"))] });
    vi.mocked(manager.updateConfig).mockClear();
    const read = vi.mocked(denyAcl.readWindowsDenyAcls).getMockImplementation()!;
    let resetting: Promise<void> | undefined;
    vi.mocked(denyAcl.readWindowsDenyAcls)
      .mockImplementationOnce(read)
      .mockImplementationOnce(paths => {
        resetting = resetAsrtSandbox();
        return read(paths, "S-1-5-21-1001");
      });
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [workspace] }))
      .rejects.toThrow(/reset|session/i);
    await resetting;
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it.each([wrapToolCommand, wrapWorkerCommand])("refuses a waiting wrap when deny verification seals its session %#", async wrap => {
    const wrapped = captureRuntime();
    const workspace = join(root, "seal-evidence");
    mkdirSync(workspace);
    const target = join(workspace, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target] });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(evidence.readWindowsReadDenyEvidence).mockImplementationOnce(async () => {
      entered();
      await wait;
      return new Map();
    });
    const pending = wrap("echo waiting", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [join(profile, "late-evidence")] } });
    await reading;
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => paths.map(() => ({
      denyMask: 0, inheritableMask: 0, parentMask: 0, directory: false,
    })));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [workspace] }))
      .rejects.toThrow(/verification/);
    wrapped.mockClear();
    release();
    await expect(pending).rejects.toThrow(/reset the sandbox session/);
    expect(wrapped).not.toHaveBeenCalled();
  });

  it("verifies a partial stamp failure before refusing access without releasing the session", async () => {
    captureRuntime();
    const grant = join(root, "partial-union");
    mkdirSync(grant);
    const target = present(join(grant, "secret"));
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(windowsHelpers.stampWindowsAclAsync).mockRejectedValueOnce(new Error("Fixture partial stamp"));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow("Fixture partial stamp");
    expect(denyAcl.readWindowsDenyAcls).toHaveBeenCalledTimes(2);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(runtime.restoreWindowsAcl).not.toHaveBeenCalled();
  });

  it("refuses the session when a partial stamp loses native read protection", async () => {
    captureRuntime();
    const grant = join(root, "lost-read");
    mkdirSync(grant);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(windowsHelpers.stampWindowsAclAsync).mockRejectedValueOnce(new Error("Fixture partial stamp"));
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementationOnce(paths => paths.map(() => ({
      denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: false,
    }))).mockImplementation(paths => paths.map(() => ({
      denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: false,
    })));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow(/reset the sandbox session/);
    await expect(wrapToolCommand("echo refused", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/reset the sandbox session/);
    expect(windowsHelpers.stampWindowsAclAsync).toHaveBeenCalledOnce();
    expect(denyAcl.readWindowsDenyAcls).toHaveBeenCalledTimes(2);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(runtime.restoreWindowsAcl).not.toHaveBeenCalled();
  });

  it("keeps write-only protection readable when native state has no stronger deny", async () => {
    captureRuntime();
    const grant = join(root, "write-only");
    mkdirSync(grant);
    const target = join(grant, "secret");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ denyWrite: [target] });
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => paths.map(() => ({
      denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: false,
    })));
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(vi.mocked(windowsHelpers.stampWindowsAclAsync).mock.calls.at(-1)?.[0].denyRead).not.toContain(target);
      expect(vi.mocked(windowsHelpers.stampWindowsAclAsync).mock.calls.at(-1)?.[0].denyWrite).toContain(target);
    } finally { held.release(); }
  });

  it.each([
    { denyMask: denyAcl.WINDOWS_WRITE_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: false },
    { denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: 0, parentMask: 0, directory: false },
    { denyMask: denyAcl.WINDOWS_READ_DENY_MASK, inheritableMask: 0, parentMask: 0x40, directory: true },
  ])("refuses insufficient native deny evidence %#", async native => {
    captureRuntime();
    const grant = join(root, "insufficient");
    mkdirSync(grant);
    const target = present(join(grant, "secret"));
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(denyAcl.readWindowsDenyAcls).mockImplementation(paths => paths.map(() => native));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow(/verification/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("watches a newly reachable absent deny instead of stamping it before granting a worker write", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, "later-write");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    expect(watchedProtectedRows()).not.toContain(target);
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(watchedProtectedRows()).toContain(target);
      expect(stampedPaths()).not.toContain(target);
      expect(runtime.grantWindowsAcl).toHaveBeenCalledOnce();
      expect(paths(config?.filesystem.denyRead)).not.toContain(target);
      expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
      await wrapToolCommand("echo after", { commandId: TEST_COMMAND_ID });
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    } finally {
      held.release();
    }
    await afterQueuedCallbacks();
    expect(watchedProtectedRows()).not.toContain(target);
    expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    expect(runtime.restoreWindowsAcl).not.toHaveBeenCalled();
  });

  it("rechecks a deny refused during worker grant release on the next wrap", async () => {
    const wrap = captureRuntime();
    const grant = join(root, "grant");
    const target = join(root, "control");
    const destination = join(root, "destination");
    for (const path of [grant, target, destination]) mkdirSync(path);
    await initializeAsrtSandbox({ denyWrite: [target] });
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    vi.mocked(manager.updateConfig).mockClear();
    rmdirSync(target);
    symlinkSync(destination, target, "junction");
    held.release();

    expect(runtime.revokeWindowsAcl).toHaveBeenCalledWith(expect.objectContaining({ holderPid: process.pid + 1 }));
    expect(manager.updateConfig).not.toHaveBeenCalled();
    await expect(wrapToolCommand("echo refused", { commandId: TEST_COMMAND_ID })).rejects.toMatchObject({
      code: "sandbox-obligation-unenforceable",
      rows: expect.arrayContaining([expect.objectContaining({ reason: "link-spelling" })]),
    });
    expect(wrap).not.toHaveBeenCalled();

    unlinkSync(target);
    mkdirSync(target);
    await expect(wrapToolCommand("echo recovered", { commandId: TEST_COMMAND_ID })).resolves.toMatchObject({ argv: ["echo"] });
  });

  it("refuses a write grant when deny stamping fails without releasing session protection", async () => {
    captureRuntime();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const grant = join(profile, "failed-write");
    mkdirSync(grant);
    const target = present(join(grant, "secret"));
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    vi.mocked(windowsHelpers.stampWindowsAclAsync).mockRejectedValueOnce(new Error("Fixture stamp failure"));
    await expect(grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] }))
      .rejects.toThrow("Fixture stamp failure");
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
    expect(runtime.restoreWindowsAcl).not.toHaveBeenCalled();
    expect(manager.updateConfig).not.toHaveBeenCalled();
    expect(warning.mock.calls.filter(call => call.some(value => String(value).includes("Fixture stamp failure")))).toHaveLength(1);
  });

  it("watches an absent deny supplied only by an earlier wrap once a later write grant reaches it", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, "wrap-only");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({});
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID,
      filesystem: { denyRead: [target], denyWrite: [target] } });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(watchedProtectedRows()).toContain(target);
      expect(stampedPaths()).not.toContain(target);
    } finally {
      held.release();
    }
  });

  it("protects a previously omitted target that appears before a later write grant", async () => {
    const wrap = captureRuntime();
    const grant = join(root, "later-created");
    mkdirSync(grant);
    const target = join(grant, "secret");
    await initializeAsrtSandbox({ denyRead: [target], denyWrite: [target] });
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    writeFileSync(target, "created outside the sandbox");
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [grant] });
    try {
      expect(windowsHelpers.stampWindowsAclAsync).toHaveBeenCalledWith(expect.objectContaining({
        holderPid: process.pid, denyRead: expect.arrayContaining([target]), denyWrite: expect.arrayContaining([target]),
      }));
    } finally {
      held.release();
    }
  });

  it("retains present machine policy rows with absolute home and environment spellings", () => {
    const machine = join(root, "machine");
    mkdirSync(join(machine, "Ave"), { recursive: true });
    vi.stubEnv("ProgramData", machine);
    const absolute = present(join(machine, "Ave", "policy.json"));
    for (const target of [absolute, "~/../machine/Ave/policy.json", "%USERPROFILE%/../machine/Ave/policy.json"]) {
      const read = buildSandboxConfig({ denyRead: [target] });
      const write = buildSandboxConfig({ allowRead: [join(machine, "Ave")], denyWrite: [target] });
      expect(paths(read.filesystem.denyRead)).toContain(absolute);
      expect(paths(write.filesystem.denyWrite)).toContain(absolute);
      if (target !== absolute) {
        expect(read.filesystem.denyRead).not.toContain(target);
        expect(paths(write.filesystem.denyWrite)).not.toContain(target);
      }
    }
  });

  it("omits an absent machine policy row from the native lists and watches it once a write grant in its folder reaches it", () => {
    const machine = join(root, "machine");
    const folder = join(machine, "Ave");
    mkdirSync(folder, { recursive: true });
    vi.stubEnv("ProgramData", machine);
    const absolute = join(folder, "missing-policy.json");
    for (const target of [absolute, "~/../machine/Ave/missing-policy.json", "%USERPROFILE%/../machine/Ave/missing-policy.json"]) {
      const read = buildSandboxConfig({ denyRead: [target] });
      const write = buildSandboxConfig({ allowRead: [folder], denyWrite: [target] });
      expect(read.filesystem.denyRead).not.toContain(target);
      expect(paths(write.filesystem.denyWrite)).not.toContain(absolute);
    }
    expect(watchedProtectedRows()).not.toContain(absolute);
    const reached = buildSandboxConfig({ denyWrite: [absolute] }, undefined, { allowWrite: [{ path: folder, literal: true }] });
    expect(paths(reached.filesystem.denyWrite)).not.toContain(absolute);
    expect(watchedProtectedRows()).toContain(absolute);
    expect(lstatSync(absolute, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("drops absent read and write rows despite failed evidence and keeps existing rows at initialization", async () => {
    captureRuntime();
    const present = join(profile, ".gitconfig");
    const absent = join(profile, ".curlrc");
    writeFileSync(present, "secret");
    await initializeAsrtSandbox({ allowRead: [profile] });
    expect(paths(config?.filesystem.denyRead)).toContain(present);
    expect(paths(config?.filesystem.denyWrite)).toContain(present);
    expect(paths(config?.filesystem.denyRead)).not.toContain(absent);
    expect(paths(config?.filesystem.denyWrite)).not.toContain(absent);
  });

  it("drops a row deleted after the snapshot at a tool wrap with no filesystem override", async () => {
    const wrap = captureRuntime();
    const target = join(profile, ".curlrc");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ allowRead: [profile] });
    rmSync(target);
    await wrapToolCommand("echo absent", { commandId: TEST_COMMAND_ID });
    const filesystem = wrap.mock.calls.at(-1)?.[2]?.filesystem;
    expect(filesystem?.denyRead).toBeDefined();
    expect(filesystem?.denyWrite).toBeDefined();
    expect(paths(filesystem?.denyRead)).not.toContain(target);
    expect(paths(filesystem?.denyWrite)).not.toContain(target);
    writeFileSync(target, "recreated");
    await wrapToolCommand("echo present", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).toContain(target);
  });

  it("reports absent at stamp time only once per path in a session", async () => {
    captureRuntime();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = join(profile, ".curlrc");
    await initializeAsrtSandbox({});
    await wrapToolCommand("echo first", { commandId: TEST_COMMAND_ID });
    await wrapToolCommand("echo second", { commandId: TEST_COMMAND_ID });
    const rows = () => warning.mock.calls.filter(call => call.some(value =>
      typeof value === "string" && value.includes(target) && value.includes("absent at stamp time")));
    expect(rows()).toHaveLength(1);
    await resetAsrtSandbox();
    await initializeAsrtSandbox({});
    expect(rows()).toHaveLength(2);
  });

  it("drops absent rows at worker and terminal restatements", async () => {
    const wrap = captureRuntime();
    const target = join(root, "absent");
    await initializeAsrtSandbox({});
    const filesystem = { denyRead: [target], denyWrite: [target] };
    await wrapWorkerCommand("echo absent", { commandId: TEST_COMMAND_ID, filesystem });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    await wrapTerminalCommand("echo absent", { commandId: TEST_COMMAND_ID, ownTty: "fixture-tty", filesystem });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
  });

  it("rechecks session updates when worker socket holders change", async () => {
    captureRuntime();
    const target = join(profile, ".curlrc");
    writeFileSync(target, "secret");
    await initializeAsrtSandbox({ allowRead: [profile] });
    rmSync(target);
    const holder = {};
    const socket = join(root, "socket");
    await registerWorkerUnixSocketDir(socket, holder);
    expect(paths(config?.filesystem.denyRead)).not.toContain(target);
    expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
    writeFileSync(target, "recreated");
    await unregisterWorkerUnixSocketDir(socket, holder);
    expect(paths(config?.filesystem.denyRead)).toContain(target);
    expect(paths(config?.filesystem.denyWrite)).toContain(target);
  });

  it("filters an alternate home anchor without dropping existing targets", () => {
    const home = join(root, "alternate");
    mkdirSync(join(home, ".config"), { recursive: true });
    vi.stubEnv("HOME", home);
    const present = join(home, ".config", "curlrc");
    const absent = join(home, ".curlrc");
    writeFileSync(present, "secret");
    const next = buildSandboxConfig({});
    expect(paths(next.filesystem.denyRead)).toContain(present);
    expect(paths(next.filesystem.denyWrite)).toContain(present);
    expect(paths(next.filesystem.denyRead)).not.toContain(absent);
    expect(paths(next.filesystem.denyWrite)).not.toContain(absent);
  });

  it("keeps writable literal targets and refuses a deny spelled on a dangling directory link", () => {
    const workspace = join(root, "workspace[1]");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    const present = join(workspace, ".bashrc");
    writeFileSync(present, "secret");
    const link = join(root, "dangling");
    symlinkSync(join(root, "missing-directory"), link, "junction");
    const absent = join(workspace, ".git", "modules");
    // A forced recursive removal stops silently at a dangling junction on Windows, so the test removes its own.
    try {
      for (const rows of [{ denyRead: [link + sep] }, { denyWrite: [link + sep] }]) {
        expect(() => buildSandboxConfig({ allowWrite: [workspace], ...rows })).toThrow(expect.objectContaining({
          code: "sandbox-obligation-unenforceable", rows: expect.arrayContaining([{ row: link + sep, reason: "link-spelling" }]),
        }));
      }
      const next = buildSandboxConfig({ allowWrite: [workspace] });
      const denyWrite = next.filesystem.denyWrite.map(entry => typeof entry === "string"
        ? nativeDenySpelling(entry) : { ...entry, path: nativeDenySpelling(entry.path) });
      expect(denyWrite).toContainEqual(expect.objectContaining({ path: present, literal: true }));
      expect(denyWrite).not.toContainEqual(expect.objectContaining({ path: absent }));
      expect(watchedProtectedRows()).toContain(absent);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      (process.platform === "win32" ? rmdirSync : unlinkSync)(link);
    }
  });

  it("binds a deny glob to its present static base and refuses confinement on a share row", () => {
    const base = join(root, "pattern");
    const glob = join(base, "missing-*");
    mkdirSync(base);
    const next = buildSandboxConfig({ denyRead: [glob], denyWrite: [glob] });
    expect(paths(next.filesystem.denyRead)).toContain(base);
    expect(paths(next.filesystem.denyRead)).not.toContain(glob);
    expect(paths(next.filesystem.denyWrite)).toContain(base);
    expect(paths(next.filesystem.denyWrite)).not.toContain(glob);
    const unc = "\\\\fixture-server\\fixture-share\\missing";
    for (const filesystem of [{ denyRead: [glob, unc] }, { denyWrite: [glob, unc] }]) {
      expect(() => buildSandboxConfig(filesystem)).toThrow(expect.objectContaining({
        code: "sandbox-obligation-unenforceable", rows: [{ row: unc, reason: "share" }],
      }));
    }
  });

  it("keeps explicit present denies while insulating unrelated floor rows from bracket grants and watches an absent reached row", async () => {
    const wrap = captureRuntime();
    const unrelated = join(profile, ".curlrc");
    const grant = join(profile, "work[1]");
    const shared = join(profile, "shared");
    const protectedTarget = join(shared, "secret");
    const absent = join(shared, "absent");
    mkdirSync(grant);
    mkdirSync(shared);
    writeFileSync(unrelated, "private");
    writeFileSync(protectedTarget, "secret");
    await initializeAsrtSandbox({});
    const filesystem = { denyRead: [unrelated, protectedTarget, absent], denyWrite: [protectedTarget, absent] };
    await wrapToolCommand("echo before", { commandId: TEST_COMMAND_ID, filesystem });
    const before = wrap.mock.calls.at(-1)?.[2]?.filesystem;
    expect(paths(before?.denyWrite)).toContain(protectedTarget);
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowRead: [grant], allowWrite: [shared] });
    try {
      await Promise.all([
        wrapToolCommand("echo one", { commandId: TEST_COMMAND_ID, filesystem }),
        wrapWorkerCommand("echo two", { commandId: TEST_COMMAND_ID, filesystem }),
      ]);
      const concurrent = wrap.mock.calls.slice(-2).map(call => call[2]?.filesystem);
      for (const next of concurrent) {
        expect(paths(next?.denyRead)).toContain(unrelated);
        expect(paths(next?.denyWrite)).not.toContain(unrelated);
        expect(paths(next?.denyRead)).toContain(protectedTarget);
        expect(paths(next?.denyWrite)).toContain(protectedTarget);
        expect(paths(next?.denyRead)).not.toContain(absent);
        expect(paths(next?.denyWrite)).not.toContain(absent);
      }
      expect(watchedProtectedRows()).toContain(absent);
      expect(paths(before?.denyRead)).toContain(unrelated);
      expect(paths(before?.denyWrite)).not.toContain(unrelated);
    } finally {
      held.release();
    }
    await wrapToolCommand("echo released", { commandId: TEST_COMMAND_ID, filesystem });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(absent);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(absent);
    expect(lstatSync(absent, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("watches absent read and write denies reached by session and caller write grants", async () => {
    const wrap = captureRuntime();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "credential");
    await initializeAsrtSandbox({ allowWrite: [workspace], denyRead: [target], denyWrite: [target] });
    expect(paths(config?.filesystem.denyRead)).not.toContain(target);
    expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
    expect(watchedProtectedRows()).toContain(target);
    await wrapToolCommand("echo protected", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    const caller = join(root, "caller");
    mkdirSync(caller);
    const absent = join(caller, "credential");
    const custom = buildPerCommandSandboxCustomConfig({ allowWrite: [caller], denyRead: [target, absent], denyWrite: [target, absent] });
    expect(paths(custom?.filesystem?.denyRead)).not.toContain(absent);
    expect(paths(custom?.filesystem?.denyWrite)).not.toContain(absent);
    expect(watchedProtectedRows()).toEqual(expect.arrayContaining([target, absent]));
    expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(absent, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("keeps a row reached by a session write root watched across an unrelated worker grant", async () => {
    captureRuntime();
    const workspace = join(root, "session-root");
    const unrelated = join(root, "unrelated-grant");
    for (const path of [workspace, unrelated]) mkdirSync(path);
    const row = join(workspace, "credential");
    await initializeAsrtSandbox({ allowWrite: [workspace], denyRead: [row], denyWrite: [row] });
    await wrapToolCommand("echo running", { commandId: TEST_COMMAND_ID });
    expect(watchedProtectedRows()).toContain(row);
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid + 1, allowWrite: [unrelated] });
    held.release();
    await afterQueuedCallbacks();
    expect(watchedProtectedRows()).toContain(row);
  });

  it("gives a worker-grant-only write root the same protected-root rows as a shared write root", () => {
    const shared = join(root, "shared-root");
    const granted = join(root, "granted-root");
    for (const dir of [shared, granted]) mkdirSync(join(dir, ".vscode"), { recursive: true });
    const next = buildSandboxConfig({ allowWrite: [shared] }, undefined, { allowWrite: [{ path: granted, literal: true }] });
    expect(paths(next.filesystem.denyWrite)).toEqual(expect.arrayContaining([join(shared, ".vscode"), join(granted, ".vscode")]));
  });

  it("does not let a bracketed session write grant retain unrelated absent denies", async () => {
    captureRuntime();
    const target = join(profile, ".curlrc");
    for (const name of ["plain", "work[1]"]) {
      const grant = join(profile, name);
      mkdirSync(grant);
      await initializeAsrtSandbox({ allowWrite: [grant] });
      expect(paths(config?.filesystem.denyRead)).not.toContain(target);
      expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
      await resetAsrtSandbox();
    }
  });

  it("drops absent floor rows beneath a live read-only grant", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, ".kube");
    mkdirSync(grant);
    const target = join(grant, "config");
    await initializeAsrtSandbox({});
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowRead: [grant] });
    try {
      await wrapToolCommand("echo readonly", { commandId: TEST_COMMAND_ID });
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    } finally {
      held.release();
    }
  });

  it("watches an absent deny beneath a live write grant until its last writer releases", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, ".kube");
    mkdirSync(grant);
    const target = join(grant, "config");
    const filesystem = { denyRead: [target], denyWrite: [target] };
    await initializeAsrtSandbox({});
    const reader = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowRead: [grant] });
    const writer = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [grant] });
    const otherWriter = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [grant] });
    try {
      writer.release();
      await wrapToolCommand("echo writable", { commandId: TEST_COMMAND_ID, filesystem });
      await afterQueuedCallbacks();
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
      expect(watchedProtectedRows()).toContain(target);
      otherWriter.release();
      await afterQueuedCallbacks();
      expect(watchedProtectedRows()).not.toContain(target);
      await wrapToolCommand("echo readonly", { commandId: TEST_COMMAND_ID, filesystem });
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    } finally {
      writer.release();
      otherWriter.release();
      reader.release();
    }
  });

  it("does not carry a live write grant across sandbox reset", async () => {
    const wrap = captureRuntime();
    const grant = join(profile, ".kube");
    mkdirSync(grant);
    const target = join(grant, "config");
    await initializeAsrtSandbox({});
    const held = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [grant] });
    try {
      await resetAsrtSandbox();
      await initializeAsrtSandbox({});
      await wrapToolCommand("echo fresh", { commandId: TEST_COMMAND_ID });
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
      expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
      expect(watchedProtectedRows()).not.toContain(target);
      const current = await grantWindowsWorkerFilesystemAccess({ holderPid: process.pid, allowWrite: [grant] });
      try {
        held.release();
        await wrapToolCommand("echo current", { commandId: TEST_COMMAND_ID,
          filesystem: { denyRead: [target], denyWrite: [target] } });
        await afterQueuedCallbacks();
        expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
        expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
        expect(watchedProtectedRows()).toContain(target);
      } finally {
        current.release();
      }
    } finally {
      held.release();
    }
  });

  it("drops absent denies reached only by a read grant", async () => {
    const wrap = captureRuntime();
    const target = join(profile, ".curlrc");
    await initializeAsrtSandbox({ allowRead: [profile] });
    expect(paths(config?.filesystem.denyRead)).not.toContain(target);
    expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
    await wrapToolCommand("echo readonly", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyRead)).not.toContain(target);
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
  });

  it("watches absent denies reached by uncertain write grant spellings within their static directory", () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "credential");
    const unrelated = join(root, "unrelated");
    for (const grant of [join(workspace, "part*"), join(workspace, "PART~1")]) {
      // Supply uncertain coverage through the existing snapshot boundary, without requesting a new native allow ACE.
      resetWatchedRows();
      const next = buildSandboxConfig({ denyRead: [target, unrelated], denyWrite: [target, unrelated] }, undefined, { allowWrite: [grant] });
      expect(paths(next.filesystem.denyRead)).not.toContain(target);
      expect(paths(next.filesystem.denyWrite)).not.toContain(target);
      expect(watchedProtectedRows()).toContain(target);
      expect(watchedProtectedRows()).not.toContain(unrelated);
      expect(paths(next.filesystem.denyRead)).not.toContain(unrelated);
      expect(paths(next.filesystem.denyWrite)).not.toContain(unrelated);
    }
  });

  function liveGrantFloor(grant: runtime.FilesystemPathEntry, within: string) {
    resetWatchedRows();
    const next = buildSandboxConfig({}, undefined, { allowWrite: [grant] });
    const inside = (path: string) => path.toLowerCase().startsWith(`${within.toLowerCase()}${sep}`);
    return {
      denyWrite: paths(next.filesystem.denyWrite).filter(inside).sort(),
      watched: [...watchedProtectedRows()].filter(inside).sort(),
    };
  }

  function repositoryRoot(path: string): void {
    mkdirSync(join(path, ".vscode"), { recursive: true });
    mkdirSync(join(path, ".git", "hooks"), { recursive: true });
    writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(path, ".git", "config"), "[core]\n");
  }

  it("pins the existing protected entries of directories a write grant pattern matches", () => {
    const workspace = join(root, "workspace");
    const partA = join(workspace, "partA");
    repositoryRoot(partA);
    const floor = liveGrantFloor(join(workspace, "part*"), partA);
    expect(floor.denyWrite).toContain(join(partA, ".vscode"));
    expect(floor.denyWrite.some(path => path.startsWith(join(partA, ".git")))).toBe(true);
    expect(floor).toEqual(liveGrantFloor({ path: partA, literal: true }, partA));
  });

  it("watches and never creates an absent protected entry in a directory a write grant pattern matches", () => {
    const workspace = join(root, "workspace");
    const partA = join(workspace, "partA");
    mkdirSync(partA, { recursive: true });
    const floor = liveGrantFloor(join(workspace, "part*"), partA);
    expect(floor.denyWrite).not.toContain(join(partA, ".vscode"));
    expect(floor.watched).toContain(join(partA, ".vscode"));
    expect(lstatSync(join(partA, ".vscode"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("floors an existing short-name write grant at its long name", ctx => {
    const workspace = join(root, "workspace");
    const long = join(workspace, "partition-alpha");
    repositoryRoot(long);
    const short = join(workspace, "PARTIT~1");
    // The volume generates no short names: nothing spells this grant.
    if (lstatSync(short, { throwIfNoEntry: false }) === undefined) ctx.skip();
    const floor = liveGrantFloor(short, long);
    expect(floor.denyWrite).toContain(join(long, ".vscode"));
    expect(floor).toEqual(liveGrantFloor({ path: long, literal: true }, long));
  });

  it("builds the same floor for an admitted literal worker grant as for its plain spelling", () => {
    const grant = join(root, "workspace", "partA");
    repositoryRoot(grant);
    const literal = liveGrantFloor({ path: grant, literal: true }, grant);
    expect(literal.denyWrite).toContain(join(grant, ".vscode"));
    expect(literal.watched).toContain(join(grant, ".idea"));
    expect(literal).toEqual(liveGrantFloor(grant, grant));
  });

  it("watches the requested deny envelope after a write pattern expands to no grants", () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "credential");
    const unrelated = join(root, "unrelated");
    const filesystem = { allowWrite: [join(workspace, "part*")], denyRead: [target, unrelated], denyWrite: [target, unrelated] };
    for (const next of [buildSandboxConfig(filesystem).filesystem, buildPerCommandSandboxCustomConfig(filesystem)!.filesystem!]) {
      expect(paths(next.allowWrite)).toEqual([]);
      expect(paths(next.denyRead)).not.toContain(target);
      expect(paths(next.denyWrite)).not.toContain(target);
      expect(paths(next.denyRead)).not.toContain(unrelated);
      expect(paths(next.denyWrite)).not.toContain(unrelated);
    }
    expect(watchedProtectedRows()).toContain(target);
    expect(watchedProtectedRows()).not.toContain(unrelated);
  });

  it("refuses an unresolved short name as a new write grant", () => {
    const grant = join(root, "workspace", "PART~1");
    expect(() => buildSandboxConfig({ allowWrite: [grant] })).toThrow(/not a plain drive path/);
    expect(() => buildPerCommandSandboxCustomConfig({ allowWrite: [grant] })).toThrow(/not a plain drive path/);
    expect(runtime.grantWindowsAcl).not.toHaveBeenCalled();
  });

  it("watches absent denies reached by home and environment write grant spellings", () => {
    const workspace = join(profile, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "credential");
    for (const grant of ["~/workspace", "%USERPROFILE%/workspace"]) {
      resetWatchedRows();
      const next = buildSandboxConfig({ allowWrite: [grant], denyRead: [target], denyWrite: [target] });
      expect(paths(next.filesystem.denyRead)).not.toContain(target);
      expect(paths(next.filesystem.denyWrite)).not.toContain(target);
      expect(watchedProtectedRows()).toContain(target);
    }
  });

  it("refuses confinement when a deny target's walk fails with EACCES or EPERM", async () => {
    captureRuntime();
    const denied = join(root, "access-denied");
    const forbidden = join(root, "operation-forbidden");
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(lstatSync).mockImplementation(((path, options) => {
      if (String(path) === denied) throw Object.assign(new Error("Fixture stat failure"), { code: "EACCES" });
      if (String(path) === forbidden) throw Object.assign(new Error("Fixture stat failure"), { code: "EPERM" });
      return actual.lstatSync(path, options);
    }) as typeof lstatSync);
    // An unreadable component proves neither a local object nor a missing one, so no deny there can be guaranteed.
    await expect(initializeAsrtSandbox({ denyRead: [denied, forbidden], denyWrite: [denied, forbidden] })).rejects.toMatchObject({
      code: "sandbox-obligation-unenforceable",
      rows: [{ row: denied, reason: "incomplete-walk" }, { row: forbidden, reason: "incomplete-walk" }],
    });
  });

  it("fails a command whose per-command deny is unenforceable, before the runtime wraps it", async () => {
    const wrap = captureRuntime();
    await initializeAsrtSandbox({});
    const unc = "\\\\fixture-server\\fixture-share\\secret";
    for (const filesystem of [{ denyRead: [unc] }, { denyWrite: [unc] }]) {
      await expect(wrapToolCommand("echo protected", { commandId: TEST_COMMAND_ID, filesystem })).rejects.toMatchObject({
        code: "sandbox-obligation-unenforceable", rows: [{ row: unc, reason: "share" }],
      });
    }
    expect(wrap).not.toHaveBeenCalled();
  });

  it("watches the absent protective git leaf beneath a writable workspace instead of handing it off", async () => {
    const wrap = captureRuntime();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, ".git");
    await initializeAsrtSandbox({ allowWrite: [workspace] });
    expect(paths(config?.filesystem.denyWrite)).not.toContain(target);
    expect(watchedProtectedRows()).toContain(target);
    await wrapToolCommand("echo protected", { commandId: TEST_COMMAND_ID });
    expect(paths(wrap.mock.calls.at(-1)?.[2]?.filesystem?.denyWrite)).not.toContain(target);
    expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
  });

});
