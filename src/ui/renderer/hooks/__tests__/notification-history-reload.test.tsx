import "../../../../../test/renderer/setup.js";
import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotificationService, IPC_NOTIFICATION_TOAST } from "../../../../main/notification-service.js";
import type { AuditLogger } from "../../../../audit/audit-logger.js";
import type { NotificationToastPayload } from "../../../../shared/notification-types.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import type { AveApi } from "../../types.js";
import { useWindowNotices } from "../use-window-notices.js";

/** The transport joins the real main ring to the real renderer hook across listener replacement. */
function sessionTransport() {
  const listeners = new Set<(record: NotificationToastPayload) => void>();
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, record: NotificationToastPayload) => {
      if (channel === IPC_NOTIFICATION_TOAST) for (const listener of listeners) listener(record);
    },
  });
  const window = { webContents: contents, isDestroyed: () => false, isMinimized: () => false };
  const show = vi.fn();
  const audit = vi.fn();
  const service = new NotificationService({
    getMainWindow: () => window as unknown as BrowserWindow,
    isReady: () => true, isTestEnv: () => false,
    notificationFactory: () => ({ show, on: () => {} }),
    auditLogger: { log: audit } as unknown as AuditLogger,
  });
  const { api } = makeMockAveApi();
  api.onNotificationToast = vi.fn((listener: (record: NotificationToastPayload) => void) => {
    listeners.add(listener);
    service.setHistorySubscriber(contents as unknown as WebContents, true);
    return () => { listeners.delete(listener); service.setHistorySubscriber(contents as unknown as WebContents, false); };
  });
  return { service, contents, show, audit, api: api as unknown as AveApi };
}

describe("notification history across renderer replacement", () => {
  it("restores boot, reload-time and live notices exactly once without repeating delivery effects", () => {
    const session = sessionTransport();
    session.service.fire({ kind: "system", title: "Boot", body: "Configuration preserved" });
    const first = renderHook(() => useWindowNotices(session.api));
    expect(first.result.current.records.map((record) => record.message)).toEqual(["Boot: Configuration preserved"]);
    const boot = first.result.current.records[0];
    if (!boot) throw new Error("Missing boot history");
    session.contents.emit("did-start-navigation", {}, "file:///app/index.html", false, true);
    first.unmount();
    session.service.fire({ kind: "system", title: "Reload", body: "Arrived during reload" });
    const second = renderHook(() => useWindowNotices(session.api));
    act(() => { session.service.fire({ kind: "system", title: "Live", body: "After readiness" }); });
    const records = second.result.current.records;
    expect(records.map((record) => record.message)).toEqual(["Live: After readiness", "Reload: Arrived during reload", "Boot: Configuration preserved"]);
    expect(records.find((record) => record.id === boot.id)?.createdAt).toBe(boot.createdAt);
    const deliveryCount = session.show.mock.calls.length;
    const auditCount = session.audit.mock.calls.length;
    act(() => {
      second.result.current.history.markRead();
      session.service.setHistorySubscriber(session.contents as unknown as WebContents, true);
      session.service.setHistorySubscriber(session.contents as unknown as WebContents, true);
    });
    expect(second.result.current.records).toHaveLength(3);
    expect(new Set(second.result.current.records.map((record) => record.id)).size).toBe(3);
    expect(second.result.current.records.every((record) => record.read)).toBe(true);
    expect(second.result.current.latestNotice).toBe(records[0]);
    expect(session.show).toHaveBeenCalledTimes(deliveryCount);
    expect(session.audit).toHaveBeenCalledTimes(auditCount);
    second.unmount();
    const third = renderHook(() => useWindowNotices(session.api));
    expect(third.result.current.records.map((record) => record.id)).toEqual(records.map((record) => record.id));
    expect(session.show).toHaveBeenCalledTimes(deliveryCount);
    expect(session.audit).toHaveBeenCalledTimes(auditCount);
    third.unmount();
  });
  it("ignores replayed identities after a local row evicts a main row from the visible cap", () => {
    const session = sessionTransport();
    for (let index = 0; index < 50; index++) session.service.fire({ kind: "system", title: "Main", body: String(index) });
    const mounted = renderHook(() => useWindowNotices(session.api));
    act(() => {
      mounted.result.current.pushToast({ severity: "success", message: "Local install result" });
      mounted.result.current.history.markRead();
    });
    const snapshot = mounted.result.current.records;
    const latest = mounted.result.current.latestNotice;
    const auditCount = session.audit.mock.calls.length;
    const osCount = session.show.mock.calls.length;
    act(() => { session.service.setHistorySubscriber(session.contents as unknown as WebContents, true); });
    expect(mounted.result.current.records).toBe(snapshot);
    expect(mounted.result.current.records).toHaveLength(50);
    expect(mounted.result.current.records[0]?.message).toBe("Local install result");
    expect(mounted.result.current.records.every((record) => record.read)).toBe(true);
    expect(mounted.result.current.latestNotice).toBe(latest);
    expect(session.audit).toHaveBeenCalledTimes(auditCount);
    expect(session.show).toHaveBeenCalledTimes(osCount);
    mounted.unmount();
  });

});
