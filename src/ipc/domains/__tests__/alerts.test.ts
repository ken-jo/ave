/**
 * The alerts domain forwards the user's answer on a card and the staged cards,
 * and nothing else: an answer it cannot name is refused before the service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { hostFrameEvent, pluginShellFrameEvent } from "../../../__tests__/test-helpers.js";
import { ALERTS } from "../../../shared/ipc-channels.js";

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const { registerAlertsHandlers } = await import("../alerts.js");

const card = { id: "alert:abc", source: { kind: "alert", pluginId: "fixturemail", kindId: "reply", alertId: "abc" } };

function register(alertsService: unknown, deps: Record<string, unknown> = {}, marketplace: unknown = {}) {
  handlers.clear();
  registerAlertsHandlers({ alertsService, auditLogger: { log: vi.fn() }, ...deps } as never, async () => marketplace as never);
  return (channel: string, ...args: unknown[]) => handlers.get(channel)!(hostFrameEvent(), ...args);
}

describe("alerts IPC", () => {
  let service: { cardClosed: ReturnType<typeof vi.fn>; listOpen: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    service = { cardClosed: vi.fn(() => true), listOpen: vi.fn(() => [card]) };
  });

  it("forwards an accepted or dismissed card to the service", () => {
    const invoke = register(service);
    expect(invoke(ALERTS.cardClosed, "abc", "accepted")).toEqual({ ok: true });
    expect(invoke(ALERTS.cardClosed, "abc", "dismissed")).toEqual({ ok: true });
    expect(service.cardClosed.mock.calls).toEqual([["abc", "accepted"], ["abc", "dismissed"]]);
  });

  it("refuses an answer it cannot name without reaching the service", () => {
    const invoke = register(service);
    expect(invoke(ALERTS.cardClosed, "abc", "withdrawn")).toEqual({ ok: false, error: "invalid-arguments" });
    expect(invoke(ALERTS.cardClosed, 7, "accepted")).toEqual({ ok: false, error: "invalid-arguments" });
    expect(service.cardClosed).not.toHaveBeenCalled();
  });

  it("serves the staged cards, and none without a service", () => {
    expect(register(service)(ALERTS.listOpen)).toEqual([card]);
    expect(register(undefined)(ALERTS.listOpen)).toEqual([]);
    expect(register(undefined)(ALERTS.cardClosed, "abc", "accepted")).toEqual({ ok: false, error: "no-alerts-service" });
  });

  it("routes Settings through the alerts service and returns its resolution", async () => {
    const row = { kindKey: "@host:due-soon", choice: { enabled: true, seenByUser: true } };
    const settingsService = {
      listKinds: vi.fn(async () => [row]),
      setKind: vi.fn(async () => row),
      setOsNotificationsEnabled: vi.fn(async () => ({ osNotificationsEnabled: false })),
    };
    const invoke = register(settingsService);
    expect(await invoke(ALERTS.listKinds)).toEqual([row]);
    expect(await invoke(ALERTS.setKind, "@host:due-soon", { enabled: true })).toEqual(row);
    expect(settingsService.setKind).toHaveBeenCalledWith("@host:due-soon", { enabled: true });
    expect(await invoke(ALERTS.setOsNotificationsEnabled, false)).toEqual({ osNotificationsEnabled: false });
    expect(settingsService.setOsNotificationsEnabled).toHaveBeenCalledWith(false);
  });

  it.each([
    [ALERTS.removePredecessor, ["fixturemail:reply"]], [ALERTS.listKinds, []], [ALERTS.listOpen, []], [ALERTS.cardClosed, ["abc", "accepted"]],
    [ALERTS.setKind, ["@host:due-soon", { enabled: true }]], [ALERTS.setOsNotificationsEnabled, [false]],
  ])("refuses a plugin frame before reaching the service on %s", async (channel, args) => {
    const reached = vi.fn();
    register({ listKinds: reached, listOpen: reached, setKind: reached, setOsNotificationsEnabled: reached, cardClosed: reached });
    expect(await handlers.get(channel)!(pluginShellFrameEvent(), ...args)).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(reached).not.toHaveBeenCalled();
  });

  it("answers without mutating when the service is absent", async () => {
    const invoke = register(undefined);
    expect(await invoke(ALERTS.listKinds)).toEqual([]);
    expect(await invoke(ALERTS.setKind, "@host:due-soon", {})).toEqual({ ok: false, error: "no-alerts-service" });
    expect(await invoke(ALERTS.setOsNotificationsEnabled, false)).toEqual({ ok: false, error: "no-alerts-service" });
  });
});

describe("retaining predecessor removal", () => {
  function setup() {
    const row = { kindKey: "successor:reply", pluginId: "successor", blockedByPredecessor: "retired-plugin", predecessor: null,
      declaration: { inherits: [{ pluginId: "retired-plugin", sourceId: "trusted" }] } };
    const listKinds = vi.fn(async () => [row]);
    const installed = [
      { name: "retired-plugin", version: "1.0.0", sourceId: "trusted", originCommit: null },
      { name: "successor", version: "2.0.0", sourceId: "trusted", originCommit: null },
    ];
    const entry = { key: { kind: "plugin", name: "retired-plugin", sourceId: "trusted" }, displayName: "Retired helper", required: false };
    const retirement = { sourceId: "trusted", successors: { plugins: [{ pluginId: "successor" }], hostKinds: [] } };
    const marketplace = {
      catalog: vi.fn(async () => ({ entries: [entry] })),
      getRetirementEntry: vi.fn(async () => retirement),
      uninstall: vi.fn(async (request: unknown) => ({ key: request, keptDataDir: null })),
    };
    const deps = { pluginMarketplace: { listInstalledPackages: vi.fn(async () => installed) },
      pluginRuntime: { getPluginManifest: vi.fn(), listPluginIds: vi.fn(() => ["retired-plugin"]) } };
    const invoke = register({ listKinds }, deps, marketplace);
    return { row, listKinds, installed, entry, retirement, marketplace, deps, invoke };
  }

  it("computes labels and eligibility in main and always requests retaining uninstall", async () => {
    const h = setup();
    expect(await h.invoke(ALERTS.listKinds)).toMatchObject([{ predecessor: {
      pluginId: "retired-plugin", label: "Retired helper", locked: false, restartRequired: false, removable: true,
    } }]);
    expect(await h.invoke(ALERTS.removePredecessor, "successor:reply")).toMatchObject({ ok: true });
    expect(h.marketplace.uninstall).toHaveBeenCalledExactlyOnceWith(
      { kind: "plugin", name: "retired-plugin", sourceId: "trusted" }, { retain: { reason: "superseded" } },
    );
  });

  it.each(["unrelated:reply", "retired-plugin", { kindKey: "successor:reply", pluginId: "unrelated", sourceId: "trusted", retain: false }])(
    "refuses renderer-selected removal targets: %j", async (input) => {
      const h = setup();
      expect(await h.invoke(ALERTS.removePredecessor, input)).toMatchObject({ ok: false });
      expect(h.marketplace.getRetirementEntry).not.toHaveBeenCalled();
      expect(h.marketplace.uninstall).not.toHaveBeenCalled();
    },
  );

  it("rejects extra renderer options rather than accepting a non-retaining path", async () => {
    const h = setup();
    expect(await h.invoke(ALERTS.removePredecessor, "successor:reply", { retain: false, sourceId: "other" }))
      .toEqual({ ok: false, error: "invalid-arguments" });
    expect(h.marketplace.uninstall).not.toHaveBeenCalled();
  });

  it("cannot remove a policy-locked predecessor and publishes its locked state", async () => {
    const h = setup(); h.entry.required = true;
    expect(await h.invoke(ALERTS.listKinds)).toMatchObject([{ predecessor: { locked: true, removable: false } }]);
    expect(await h.invoke(ALERTS.removePredecessor, "successor:reply")).toEqual({ ok: false, error: "predecessor-policy-locked" });
    expect(h.marketplace.uninstall).not.toHaveBeenCalled();
  });

  it.each(["unnamed", "foreign-successor", "foreign-predecessor", "missing", "unblocked"])("refuses %s predecessor authority", async (reason) => {
    const h = setup();
    if (reason === "unnamed") h.retirement.successors.plugins = [];
    if (reason === "foreign-successor") h.installed[1]!.sourceId = "other";
    if (reason === "foreign-predecessor") h.installed[0]!.sourceId = "other";
    if (reason === "missing") h.installed.splice(0, 1);
    if (reason === "unblocked") h.row.blockedByPredecessor = "";
    expect(await h.invoke(ALERTS.removePredecessor, "successor:reply")).toEqual({ ok: false, error: "predecessor-not-removable" });
    expect(h.marketplace.uninstall).not.toHaveBeenCalled();
  });

  it("rechecks the registered declaration after asynchronous metadata reads", async () => {
    const h = setup();
    h.listKinds.mockResolvedValueOnce([h.row]).mockResolvedValueOnce([{ ...h.row, blockedByPredecessor: "other" }]);
    expect(await h.invoke(ALERTS.removePredecessor, "successor:reply")).toEqual({ ok: false, error: "predecessor-not-removable" });
    expect(h.marketplace.uninstall).not.toHaveBeenCalled();
  });

  it("maps a policy change during uninstall to a stable error", async () => {
    const { MarketplaceError } = await import("../../../marketplace/errors.js");
    const h = setup(); h.marketplace.uninstall.mockRejectedValueOnce(new MarketplaceError("PACKAGE_REQUIRED_BY_POLICY", "locked"));
    expect(await h.invoke(ALERTS.removePredecessor, "successor:reply")).toEqual({ ok: false, error: "predecessor-policy-locked" });
  });

  it("shows a next-restart state for a revoked predecessor that is still loaded", async () => {
    const { revocationRegistry } = await import("../../../plugins/revocation/revocation-registry.js");
    const h = setup();
    revocationRegistry.replace([{ sourceId: "trusted", kind: "plugin", name: "retired-plugin", versions: "*", reason: "retired", at: "2026-09-01", action: "disable" }]);
    try { expect(await h.invoke(ALERTS.listKinds)).toMatchObject([{ predecessor: { restartRequired: true } }]); }
    finally { revocationRegistry.resetForTesting(); }
  });
});
