/**
 * The alerts domain forwards the user's answer on a card and the staged cards,
 * and nothing else: an answer it cannot name is refused before the service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { hostFrameEvent } from "../../../__tests__/test-helpers.js";
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
  let service: { cardClosed: ReturnType<typeof vi.fn>; openCards: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    service = { cardClosed: vi.fn(() => true), openCards: vi.fn(() => [card]) };
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
    expect(register(service)(ALERTS.openCards)).toEqual([card]);
    expect(register(undefined)(ALERTS.openCards)).toEqual([]);
    expect(register(undefined)(ALERTS.cardClosed, "abc", "accepted")).toEqual({ ok: false, error: "no-alerts-service" });
  });
});
