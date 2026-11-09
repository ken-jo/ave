// @vitest-environment jsdom
/** Window producers report to session history without pane-local queue expiry. */
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useWindowNotices } from "../use-window-notices.js";
import type { AveApi, NotificationToastPayload } from "../../types.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import type { PluginInstallResultPayload } from "../../../../contract/app-contract.js";

function windowNoticeApi(overrides: Partial<AveApi> = {}): AveApi {
  const { api } = makeMockAveApi();
  Object.assign(api, overrides);
  return api as unknown as AveApi;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("useWindowNotices — notification producer", () => {
  it("keeps every record newest first until cleared, irrespective of sticky flags or elapsed time", () => {
    let emit!: (payload: NotificationToastPayload) => void;
    const unsubscribe = vi.fn();
    const api = windowNoticeApi({ onNotificationToast: (handler) => { emit = handler; return unsubscribe; } });
    const { result, unmount } = renderHook(() => useWindowNotices(api));
    act(() => {
      emit({ id: "main:1", createdAt: Date.now(), kind: "alert", title: "Meeting", body: "starting", sticky: true });
      emit({ id: "main:2", createdAt: Date.now(), kind: "system", title: "Mail", body: "new" });
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.records.map((record) => record.message)).toEqual(["Mail: new", "Meeting: starting"]);
    expect(result.current.records.map((record) => record.source)).toEqual(["system", "alert"]);
    expect(result.current.latestNotice?.message).toBe("Mail: new");
    const latest = result.current.records[0];
    if (!latest) throw new Error("Missing notification record");
    act(() => result.current.history.clear(latest.id));
    expect(result.current.records.map((record) => record.message)).toEqual(["Meeting: starting"]);
    act(() => result.current.history.clearAll());
    expect(result.current.records).toEqual([]);
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(["approval", "ask-user"] as const)("does not record %s requests even if received on the notification channel", (kind) => {
    let emit!: (payload: NotificationToastPayload) => void;
    const api = windowNoticeApi({ onNotificationToast: (handler) => { emit = handler; return () => {}; } });
    const { result } = renderHook(() => useWindowNotices(api));
    act(() => emit({ id: "main:1", createdAt: Date.now(), kind, title: "Request", body: "Decide on its card" }));
    expect(result.current.records).toEqual([]);
    expect(result.current.latestNotice).toBeNull();
  });

  it("rejects history records without a stable identity or finite arrival time", () => {
    let emit!: (payload: NotificationToastPayload) => void;
    const api = windowNoticeApi({ onNotificationToast: (handler) => { emit = handler; return () => {}; } });
    const { result } = renderHook(() => useWindowNotices(api));
    act(() => {
      emit({ kind: "system", title: "Invalid", body: "Missing identity" } as NotificationToastPayload);
      emit({ id: "main:1", createdAt: Number.NaN, kind: "system", title: "Invalid", body: "Invalid time" });
    });
    expect(result.current.records).toEqual([]);
  });

  it("retains both announcement severities when arrivals share a render", () => {
    const { result } = renderHook(() => useWindowNotices(windowNoticeApi()));
    act(() => {
      result.current.pushToast({ severity: "error", message: "Install failed" });
      result.current.pushToast({ severity: "success", message: "Other install finished" });
    });
    expect(result.current.latestError?.message).toBe("Install failed");
    expect(result.current.latestPolite?.message).toBe("Other install finished");
  });

  it("sanitizes notification fields and retains navigation metadata", () => {
    let emit!: (payload: NotificationToastPayload) => void;
    const api = windowNoticeApi({ onNotificationToast: (handler) => { emit = handler; return () => {}; } });
    const { result } = renderHook(() => useWindowNotices(api));
    act(() => emit({ id: "main:1", createdAt: Date.now(), kind: "routine", title: "Re\x00port", body: "Re\nady", contextRef: { routineId: "routine-1" } }));
    expect(result.current.records[0]).toMatchObject({
      message: "Report: Ready", severity: "success", source: "routine", notification: { kind: "routine", contextRef: { routineId: "routine-1" } },
    });
  });
});

describe("useWindowNotices — install lifecycle producer", () => {
  function renderWithInstallHandler() {
    let emit!: (payload: PluginInstallResultPayload) => void;
    const unsubscribe = vi.fn();
    const api = windowNoticeApi({ onPluginInstallResult: vi.fn((handler) => { emit = handler; return unsubscribe; }) });
    const hook = renderHook(() => useWindowNotices(api));
    expect(api.onPluginInstallResult).toHaveBeenCalledOnce();
    return { ...hook, unsubscribe, emit: (payload: PluginInstallResultPayload) => act(() => emit(payload)) };
  }

  it("records successful installs and unsubscribes its producer", () => {
    const { result, emit, unmount, unsubscribe } = renderWithInstallHandler();
    emit({ slug: "samplehub", success: true });
    expect(result.current.records).toHaveLength(1);
    expect(result.current.records[0]).toMatchObject({ severity: "success", message: "samplehub 설치 완료", source: "window" });
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("strips C0 and DEL controls from install slugs", () => {
    const { result, emit } = renderWithInstallHandler();
    emit({ slug: "ev\x00il", success: true });
    expect(result.current.records[0]?.message).toBe("evil 설치 완료");
    emit({ slug: "a\tb\nc\rd\x7f", success: true });
    expect(result.current.records[0]?.message).toBe("abcd 설치 완료");
  });

  it("replaces a slug's earlier result with the latest outcome", () => {
    const { result, emit } = renderWithInstallHandler();
    emit({ slug: "sampleassistant", success: false, error: "disk full" });
    const recordId = result.current.records[0]?.id;
    expect(result.current.records[0]?.severity).toBe("error");
    emit({ slug: "sampleassistant", success: true });
    expect(result.current.records).toHaveLength(1);
    expect(result.current.records[0]).toMatchObject({ id: recordId, severity: "success", message: "sampleassistant 설치 완료" });
  });

  it("retains an entire install burst newest first after former toast deadlines", () => {
    const { result, emit } = renderWithInstallHandler();
    emit({ slug: "plugin-a", success: true });
    emit({ slug: "plugin-b", success: true });
    emit({ slug: "plugin-c", success: true });
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.records.map((record) => record.message)).toEqual([
      "plugin-c 설치 완료", "plugin-b 설치 완료", "plugin-a 설치 완료",
    ]);
    expect(result.current.latestNotice?.message).toBe("plugin-c 설치 완료");
  });
});
