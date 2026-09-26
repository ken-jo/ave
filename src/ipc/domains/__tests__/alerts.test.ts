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

function register(alertsService: unknown) {
  handlers.clear();
  registerAlertsHandlers({ alertsService, auditLogger: { log: vi.fn() } } as never);
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
    [ALERTS.listKinds, []], [ALERTS.listOpen, []], [ALERTS.cardClosed, ["abc", "accepted"]],
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
