import { dispatchPermissionReviewerCommandWithRewire } from "../permission-slash.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPermissionSettings, setReviewerSettingsPersist } from "../permission-settings-store.js";
import { useConfigurationOwner as configureTestOwner } from "../../__tests__/support/configuration-owner.js";

// Lets one test refuse the final write that clears a mode change's record, the way a full disk would.
const clearFailure = vi.hoisted(() => ({ next: undefined as Error | undefined }));
vi.mock("../permission-settings-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../permission-settings-store.js")>();
  return { ...actual, finishPermissionModeChangePersist: async (...args: Parameters<typeof actual.finishPermissionModeChangePersist>) => {
    const failure = clearFailure.next;
    if (failure !== undefined && args[2] === undefined) { clearFailure.next = undefined; throw failure; }
    return actual.finishPermissionModeChangePersist(...args);
  } };
});

configureTestOwner();

import { applyPermissionModeCommand, permissionModeReviewerOverride, recoverInterruptedPermissionModeChange } from "../permission-mode-apply.js";
import { PermissionManager } from "../permission-manager.js";
import type { PermissionModeCommand } from "../permission-slash.js";

const fixtureDirectories: string[] = [];
afterEach(() => { for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function makeDeps() {
  const directory = mkdtempSync(join(tmpdir(), "permission-mode-"));
  fixtureDirectories.push(directory);
  const reviewerSettingsPath = join(directory, "settings.json");
  let mode: PermissionModeCommand["mode"] = "default";
  const permissionManager = {
    getMode: vi.fn(() => mode),
    setMode: vi.fn((next: PermissionModeCommand["mode"]) => {
      mode = next;
    }),
    setModePersist: vi.fn(async (next: PermissionModeCommand["mode"]) => {
      mode = next;
    }),
  };
  const approvalGate = {
    requestAndWait: vi.fn(async (req: { id: string }) => ({
      requestId: req.id,
      choice: "allow-once" as const,
    })),
  };
  const auditLogger = {
    isPermissionAuditChainReady: vi.fn(() => true),
    appendPermissionAuditEntry: vi.fn(async () => undefined),
  };
  return { permissionManager, approvalGate, auditLogger, reviewerSettingsPath };
}

const durableAuto: PermissionModeCommand = {
  kind: "mode",
  mode: "auto",
  durable: true,
} as never;

// What the EXTERNAL channel is now allowed to send: session-scoped, non-`allow`.
const sessionAuto: PermissionModeCommand = {
  kind: "mode",
  mode: "auto",
  durable: false,
} as never;

const EXTERNAL_BYPASS = {
  source: "local-api-approval",
  trustOrigin: "local-api",
  explicitUserAction: true,
} as const;

describe("applyPermissionModeCommand", () => {
  it("uses the approval gate for durable mode changes without a trusted built-in confirmation", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(durableAuto, deps as never);

    expect(result).toMatchObject({ ok: true, mode: "auto", durable: true });
    expect(deps.approvalGate.requestAndWait).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "/permission mode",
        trustOrigin: "user-keyboard",
      }),
    );
    expect(deps.permissionManager.setModePersist).toHaveBeenCalledWith("auto");
  });

  // The approval card answers a conversation-scoped remembered allow with allow-session; it approves the switch like any other allow.
  it.each(["allow-session", "allow-always"] as const)("applies a durable mode change the person answered %s", async (choice) => {
    const deps = makeDeps();
    deps.approvalGate.requestAndWait.mockImplementationOnce(async (req: { id: string }) => ({ requestId: req.id, choice } as never));
    expect(await applyPermissionModeCommand(durableAuto, deps as never)).toMatchObject({ ok: true, mode: "auto", durable: true });
    expect(deps.permissionManager.setModePersist).toHaveBeenCalledWith("auto");
  });

  it("does not request approval for durable mode changes backed by explicit built-in user action", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(durableAuto, {
      ...deps,
      approvalBypass: {
        source: "settings-ui",
        trustOrigin: "user-keyboard",
        explicitUserAction: true,
      },
    } as never);

    expect(result).toMatchObject({ ok: true, mode: "auto", durable: true });
    expect(deps.approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "mode_change",
        trustOrigin: "user-keyboard",
        fromMode: "default",
        toMode: "auto",
        durable: true,
        confirmationSource: "settings-ui",
      }),
    );
    expect(deps.permissionManager.setModePersist).toHaveBeenCalledWith("auto");
  });

  // 3-agent cluster review of critic minor 1 + audit forensics
  it("does not request approval for a SESSION-scoped mode change backed by a local-api-approval bypass, and pins the confirmationSource forensic marker", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(sessionAuto, {
      ...deps,
      approvalBypass: EXTERNAL_BYPASS,
    } as never);

    expect(result).toMatchObject({ ok: true, mode: "auto", durable: false });
    expect(deps.approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "mode_change",
        trustOrigin: "user-keyboard",
        fromMode: "default",
        toMode: "auto",
        durable: false,
        confirmationSource: "local-api-approval",
      }),
    );
    // Session-scoped: in-memory only, never written to permissions.json.
    expect(deps.permissionManager.setMode).toHaveBeenCalledWith("auto");
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  // External-channel ceiling One ApprovalGate click is consent to ONE change, not to a standing grant.
  it("refuses a DURABLE mode change on the external channel — nothing is persisted and nothing is audited as applied", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(durableAuto, {
      ...deps,
      approvalBypass: EXTERNAL_BYPASS,
    } as never);

    expect(result).toMatchObject({ ok: false, error: "external-durable-forbidden" });
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
    expect(deps.permissionManager.setMode).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("refuses the `allow` mode on the external channel even session-scoped", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(
      { kind: "mode", mode: "allow", durable: false } as never,
      { ...deps, approvalBypass: EXTERNAL_BYPASS } as never,
    );

    expect(result).toMatchObject({ ok: false, error: "external-mode-forbidden" });
    expect(deps.permissionManager.setMode).not.toHaveBeenCalled();
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("keeps `allow` reachable for the in-app settings surface (local UI is a different trust context)", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(
      { kind: "mode", mode: "allow", durable: true } as never,
      {
        ...deps,
        approvalBypass: {
          source: "settings-ui",
          trustOrigin: "user-keyboard",
          explicitUserAction: true,
        },
      } as never,
    );

    expect(result).toMatchObject({ ok: true, mode: "allow", durable: true });
    expect(deps.permissionManager.setModePersist).toHaveBeenCalledWith("allow");
  });

  // The bypass union pins trustOrigin: ExternalOrigin for the local-api-approval variant, but callers hand-build these literals (src/engine/turn/commands.ts) so a bad cast at a JS call site can smuggle a non-external origin in. The apply path must re-check at runtime, not trust the type.
  it("still asks the approval gate when a local-api-approval bypass carries a non-external trustOrigin", async () => {
    const deps = makeDeps();
    deps.approvalGate.requestAndWait.mockResolvedValueOnce({
      requestId: "r", choice: "deny" as never,
    } as never);

    const result = await applyPermissionModeCommand(durableAuto, {
      ...deps,
      approvalBypass: {
        source: "local-api-approval",
        trustOrigin: "user-keyboard",
        explicitUserAction: true,
      },
    } as never);

    expect(deps.approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, error: "durable-mode-denied" });
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("does not attribute a rejected bypass in the permission audit chain", async () => {
    const deps = makeDeps();

    const result = await applyPermissionModeCommand(durableAuto, {
      ...deps,
      approvalBypass: {
        source: "local-api-approval",
        trustOrigin: "garbage-origin",
        explicitUserAction: true,
      },
    } as never);

    expect(result).toMatchObject({ ok: true });
    expect(deps.approvalGate.requestAndWait).toHaveBeenCalledTimes(1);
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "mode_change", confirmationSource: undefined }),
    );
  });
});


describe("host-owned reviewer and execution mode changes", () => {
  const localConfirmation = { source: "settings-ui", trustOrigin: "user-keyboard", explicitUserAction: true } as const;

  it("saves both modes before the reviewer is reconfigured for a durable auto selection", async () => {
    const deps = makeDeps();
    await setReviewerSettingsPersist({ mode: "disabled" }, deps.reviewerSettingsPath);
    const rewireReviewerAgent = vi.fn(async () => {
      const stored = readPermissionSettings(deps.reviewerSettingsPath).permissions;
      expect(stored.reviewer.mode).toBe("llm");
      expect(stored.pendingModeChange).toBeUndefined();
      expect(deps.permissionManager.setModePersist).toHaveBeenCalledExactlyOnceWith("auto");
    });
    expect(await applyPermissionModeCommand(durableAuto, { ...deps, rewireReviewerAgent, approvalBypass: localConfirmation } as never)).toMatchObject({ ok: true, mode: "auto", durable: true });
    expect(deps.permissionManager.setModePersist).toHaveBeenCalledExactlyOnceWith("auto");
    expect(rewireReviewerAgent).toHaveBeenCalledTimes(1);
    expect(readPermissionSettings(deps.reviewerSettingsPath).permissions.reviewer.mode).toBe("llm");
  });

  it("keeps an external session selection's reviewer configuration in memory", async () => {
    const deps = makeDeps();
    await setReviewerSettingsPersist({ mode: "disabled" }, deps.reviewerSettingsPath);
    const rewireReviewerAgent = vi.fn(async () => {
      expect(permissionModeReviewerOverride(deps.permissionManager as never)).toBe("llm");
      expect(readPermissionSettings(deps.reviewerSettingsPath).permissions.reviewer.mode).toBe("disabled");
    });
    expect(await applyPermissionModeCommand(sessionAuto, { ...deps, rewireReviewerAgent, approvalBypass: EXTERNAL_BYPASS } as never)).toMatchObject({ ok: true, mode: "auto", durable: false });
    expect(readPermissionSettings(deps.reviewerSettingsPath).permissions.reviewer.mode).toBe("disabled");
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
    expect(deps.permissionManager.setMode).toHaveBeenCalledExactlyOnceWith("auto");
  });

  it("saves the previous pair again when reconfiguration fails", async () => {
    const deps = makeDeps();
    await setReviewerSettingsPersist({ mode: "disabled" }, deps.reviewerSettingsPath);
    const rewireReviewerAgent = vi.fn().mockRejectedValueOnce(new Error("reviewer unavailable")).mockResolvedValue(undefined);
    expect(await applyPermissionModeCommand(durableAuto, { ...deps, rewireReviewerAgent, approvalBypass: localConfirmation } as never)).toMatchObject({ ok: false, error: "reviewer-mode-change-failed" });
    expect(readPermissionSettings(deps.reviewerSettingsPath).permissions).toMatchObject({ reviewer: { mode: "disabled" } });
    expect(readPermissionSettings(deps.reviewerSettingsPath).permissions.pendingModeChange).toBeUndefined();
    expect(deps.permissionManager.setModePersist.mock.calls.map(([mode]) => mode)).toEqual(["auto", "default"]);
    expect(deps.permissionManager.getMode()).toBe("default");
    expect(rewireReviewerAgent).toHaveBeenCalledTimes(2);
  });

  it("reports a reviewer settings file it cannot update and leaves the mode unchanged", async () => {
    const deps = makeDeps();
    writeFileSync(deps.reviewerSettingsPath, "{not json");
    const rewireReviewerAgent = vi.fn(async () => undefined);
    expect(await applyPermissionModeCommand(durableAuto, { ...deps, rewireReviewerAgent, approvalBypass: localConfirmation } as never))
      .toMatchObject({ ok: false, error: "reviewer-mode-change-failed" });
    expect(readFileSync(deps.reviewerSettingsPath, "utf8")).toBe("{not json");
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
    expect(rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("restores the reviewer when saving the execution mode fails", async () => {
    const deps = makeDeps();
    await setReviewerSettingsPersist({ mode: "disabled" }, deps.reviewerSettingsPath);
    deps.permissionManager.setModePersist.mockRejectedValueOnce(new Error("mode storage failed"));
    const rewireReviewerAgent = vi.fn(async () => undefined);
    await expect(applyPermissionModeCommand(durableAuto, { ...deps, rewireReviewerAgent, approvalBypass: localConfirmation } as never)).rejects.toThrow("mode storage failed");
    expect(readPermissionSettings(deps.reviewerSettingsPath).permissions.reviewer.mode).toBe("disabled");
    expect(readPermissionSettings(deps.reviewerSettingsPath).permissions.pendingModeChange).toBeUndefined();
    expect(deps.permissionManager.getMode()).toBe("default");
    // Nothing was published, so the running reviewer never needed reconfiguring.
    expect(rewireReviewerAgent).not.toHaveBeenCalled();
  });
});


describe("serialized mode configuration", () => {
  it("keeps concurrent selections paired with their own reviewer configuration", async () => {
    const deps = makeDeps();
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const rewireReviewerAgent = vi.fn(async () => {
      if (rewireReviewerAgent.mock.calls.length === 1) { markStarted(); await firstBlocked; }
    });
    const approvalBypass = { source: "settings-ui", trustOrigin: "user-keyboard", explicitUserAction: true } as const;
    const first = applyPermissionModeCommand(durableAuto, { ...deps, rewireReviewerAgent, approvalBypass } as never);
    await firstStarted;
    const second = applyPermissionModeCommand({ mode: "strict", durable: true } as never, { ...deps, rewireReviewerAgent, approvalBypass } as never);
    expect(readPermissionSettings(deps.reviewerSettingsPath).permissions.reviewer.mode).toBe("llm");
    expect(deps.permissionManager.setModePersist.mock.calls.map(([mode]) => mode)).toEqual(["auto"]);
    releaseFirst();
    expect(await first).toMatchObject({ ok: true, mode: "auto" });
    expect(await second).toMatchObject({ ok: true, mode: "strict" });
    expect(deps.permissionManager.getMode()).toBe("strict");
    expect(readPermissionSettings(deps.reviewerSettingsPath).permissions.reviewer.mode).toBe("disabled");
    expect(deps.permissionManager.setModePersist.mock.calls.map(([mode]) => mode)).toEqual(["auto", "strict"]);
  });
});


describe("explicit reviewer recovery after a session mode change", () => {
  it("lets an explicit reviewer selection replace the session override", async () => {
    const deps = makeDeps();
    await setReviewerSettingsPersist({ mode: "disabled" }, deps.reviewerSettingsPath);
    await applyPermissionModeCommand(sessionAuto, { ...deps, approvalBypass: EXTERNAL_BYPASS } as never);
    expect(permissionModeReviewerOverride(deps.permissionManager as never)).toBe("llm");
    const rewire = vi.fn(async () => {
      expect(permissionModeReviewerOverride(deps.permissionManager as never)).toBeUndefined();
      expect(readPermissionSettings(deps.reviewerSettingsPath).permissions.reviewer.mode).toBe("disabled");
    });
    expect(await dispatchPermissionReviewerCommandWithRewire({ verb: "mode", value: "disabled" }, rewire, deps.reviewerSettingsPath, deps.permissionManager as never)).toMatchObject({ ok: true, settings: { mode: "disabled" } });
    expect(permissionModeReviewerOverride(deps.permissionManager as never)).toBeUndefined();
    expect(rewire).toHaveBeenCalledTimes(1);
  });

  it("restores the session override if explicit reviewer recovery cannot rewire", async () => {
    const deps = makeDeps();
    await setReviewerSettingsPersist({ mode: "disabled" }, deps.reviewerSettingsPath);
    await applyPermissionModeCommand(sessionAuto, { ...deps, approvalBypass: EXTERNAL_BYPASS } as never);
    const rewire = vi.fn().mockRejectedValueOnce(new Error("recovery unavailable")).mockResolvedValue(undefined);
    expect(await dispatchPermissionReviewerCommandWithRewire({ verb: "mode", value: "disabled" }, rewire, deps.reviewerSettingsPath, deps.permissionManager as never)).toMatchObject({ ok: false, error: "reviewer-rewire-failed: recovery unavailable" });
    expect(permissionModeReviewerOverride(deps.permissionManager as never)).toBe("llm");
    expect(rewire).toHaveBeenCalledTimes(2);
  });
});


describe("durable mode change across a restart", () => {
  const localConfirmation = { source: "settings-ui", trustOrigin: "user-keyboard", explicitUserAction: true } as const;
  const durableStrict = { kind: "mode", mode: "strict", durable: true } as never as PermissionModeCommand;

  async function storesInAuto() {
    const directory = mkdtempSync(join(tmpdir(), "permission-mode-restart-"));
    fixtureDirectories.push(directory);
    const paths = { permissionsFilePath: join(directory, "permissions.json"), reviewerSettingsPath: join(directory, "settings.json") };
    const manager = new PermissionManager(paths.permissionsFilePath);
    await manager.loadRulesFromFile();
    await manager.setModePersist("auto");
    await setReviewerSettingsPersist({ mode: "llm" }, paths.reviewerSettingsPath);
    return { manager, paths };
  }

  /** What a host that died at this instant would boot from: a copy of both stores, recovered and read the way boot reads them. */
  async function bootFromCopy(paths: { permissionsFilePath: string; reviewerSettingsPath: string }) {
    const directory = mkdtempSync(join(tmpdir(), "permission-mode-crash-"));
    fixtureDirectories.push(directory);
    const copy = { permissionsFilePath: join(directory, "permissions.json"), reviewerSettingsPath: join(directory, "settings.json") };
    copyFileSync(paths.permissionsFilePath, copy.permissionsFilePath);
    copyFileSync(paths.reviewerSettingsPath, copy.reviewerSettingsPath);
    await recoverInterruptedPermissionModeChange(copy);
    const restarted = new PermissionManager(copy.permissionsFilePath);
    await restarted.loadRulesFromFile();
    const settings = readPermissionSettings(copy.reviewerSettingsPath).permissions;
    return { executionMode: restarted.getMode(), reviewerMode: settings.reviewer.mode, pending: settings.pendingModeChange };
  }

  it("boots a coherent pair when the host stops after the reviewer write and before the mode write", async () => {
    const { manager, paths } = await storesInAuto();
    let crashImage: Awaited<ReturnType<typeof bootFromCopy>> | undefined;
    const persist = manager.setModePersist.bind(manager);
    vi.spyOn(manager, "setModePersist").mockImplementation(async (mode) => {
      crashImage = await bootFromCopy(paths);
      await persist(mode);
    });
    expect(await applyPermissionModeCommand(durableStrict, { permissionManager: manager, approvalBypass: localConfirmation,
      reviewerSettingsPath: paths.reviewerSettingsPath })).toMatchObject({ ok: true, mode: "strict", durable: true });
    expect(crashImage).toEqual({ executionMode: "strict", reviewerMode: "disabled", pending: undefined });
  });

  it("boots a coherent pair when the host stops after the mode write and before the intent is cleared", async () => {
    const { manager, paths } = await storesInAuto();
    let crashImage: Awaited<ReturnType<typeof bootFromCopy>> | undefined;
    const persist = manager.setModePersist.bind(manager);
    vi.spyOn(manager, "setModePersist").mockImplementation(async (mode) => {
      await persist(mode);
      crashImage = await bootFromCopy(paths);
    });
    await applyPermissionModeCommand(durableStrict, { permissionManager: manager, approvalBypass: localConfirmation, reviewerSettingsPath: paths.reviewerSettingsPath });
    expect(crashImage).toEqual({ executionMode: "strict", reviewerMode: "disabled", pending: undefined });
    expect(await bootFromCopy(paths)).toEqual({ executionMode: "strict", reviewerMode: "disabled", pending: undefined });
  });

  it("reconfigures the running reviewer and reports the failure when the change record cannot be cleared", async () => {
    const { manager, paths } = await storesInAuto();
    const rewireReviewerAgent = vi.fn(async () => {
      expect(readPermissionSettings(paths.reviewerSettingsPath).permissions.reviewer.mode).toBe("disabled");
    });
    clearFailure.next = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    await expect(applyPermissionModeCommand(durableStrict, { permissionManager: manager, approvalBypass: localConfirmation,
      reviewerSettingsPath: paths.reviewerSettingsPath, rewireReviewerAgent })).rejects.toThrow("change record could not be cleared");
    expect(manager.getMode()).toBe("strict");
    expect(rewireReviewerAgent).toHaveBeenCalledOnce();
    expect(readPermissionSettings(paths.reviewerSettingsPath).permissions.pendingModeChange).toMatchObject({ executionMode: "strict" });
    expect(await bootFromCopy(paths)).toEqual({ executionMode: "strict", reviewerMode: "disabled", pending: undefined });
  });

  it("reports an unreadable intent as a fault and leaves the stored mode alone", async () => {
    const { paths } = await storesInAuto();
    const document = JSON.parse(readFileSync(paths.reviewerSettingsPath, "utf8"));
    document.permissions.pendingModeChange = { operationId: "not-a-uuid", executionMode: "strict", reviewerMode: "disabled" };
    writeFileSync(paths.reviewerSettingsPath, JSON.stringify(document));
    expect(readPermissionSettings(paths.reviewerSettingsPath).fault).toMatchObject({ kind: "pending-mode-change-malformed" });
    await recoverInterruptedPermissionModeChange(paths);
    const restarted = new PermissionManager(paths.permissionsFilePath);
    await restarted.loadRulesFromFile();
    expect(restarted.getMode()).toBe("auto");
  });
});

describe("mode change at quit", () => {
  it.each([true, false])("applies no mode when quit seals admission during the mode audit (durable=%s)", async (durable) => {
    // A sealed ledger is process-wide; load a fresh one.
    vi.resetModules();
    const { applyPermissionModeCommand: apply } = await import("../permission-mode-apply.js");
    const ledger = await import("../../tools/invocation-ledger.js");
    const deps = makeDeps();
    deps.auditLogger.appendPermissionAuditEntry.mockImplementation(async (...args: unknown[]) => {
      if ((args[0] as { decision?: string }).decision === "mode_change") ledger.sealToolInvocations();
      return undefined;
    });
    const result = await apply({ ...durableAuto, durable }, { ...deps, approvalBypass: { source: "settings-ui", trustOrigin: "user-keyboard", explicitUserAction: true } } as never);
    expect(result).toMatchObject({ ok: false, error: "host-shutdown" });
    expect(deps.permissionManager.setModePersist).not.toHaveBeenCalled();
    expect(deps.permissionManager.setMode).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenLastCalledWith(expect.objectContaining({
      decision: "deny", tool: "/permission mode", denyReasons: [{ reason: "host-shutdown", source: "permission-mode" }],
    }));
  });
});
