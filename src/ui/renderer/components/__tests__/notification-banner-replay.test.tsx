// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { StrictMode, useLayoutEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarketplaceAnnouncement, MarketplaceAnnouncementActionTarget } from "../../../../shared/marketplace-announcements.js";
import type { NotificationToastPayload } from "../../../../shared/notification-types.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { NotificationHistoryContext } from "../../context/NotificationHistoryContext.js";
import { useWindowNotices } from "../../hooks/use-window-notices.js";
import type { NoticeRecord, NotificationHistory } from "../../notification-history.js";
import type { AveApi } from "../../types.js";
import { MarketplaceAnnouncementBanner } from "../MarketplaceAnnouncementBanner.js";
import { NotificationBell } from "../NotificationBell.js";

const ANNOUNCEMENT: MarketplaceAnnouncement = {
  id: 10, title: "Maintenance", body: "A restart is required", level: "critical",
  createdAt: "2026-11-09T00:00:00Z", startsAt: null, endsAt: null,
  actions: [{ label: { en: "Details", ko: "자세히" }, target: { kind: "url", url: "https://example.com/maintenance" } }],
};
const BANNER_ID = "banner:marketplace:10";

type HistoryHolder = { current?: NotificationHistory };

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected notification history value");
  return value;
}

function NoticeWindow({ api, holder, onAction, mounted = true }: {
  api: AveApi;
  holder: HistoryHolder;
  onAction: (target: MarketplaceAnnouncementActionTarget) => void;
  mounted?: boolean;
}) {
  const { history } = useWindowNotices(api);
  const [dismissed, setDismissed] = useState(false);
  useLayoutEffect(() => { holder.current = history; }, [history, holder]);
  return <NotificationHistoryContext.Provider value={history}>
    {mounted && <MarketplaceAnnouncementBanner announcements={dismissed ? [] : [ANNOUNCEMENT]}
      onDismiss={() => setDismissed(true)} onAction={onAction} />}
    <NotificationBell history={history} />
  </NotificationHistoryContext.Provider>;
}

/** Replay uses the same callback boundary as the renderer's notification subscription. */
function retainedNotices(holder: HistoryHolder, firstCreatedAt: number) {
  const records: NotificationToastPayload[] = Array.from({ length: 50 }, (_, index) => ({
    id: `retained:${index + 1}`, createdAt: firstCreatedAt + index,
    kind: "system", title: "Historical", body: String(index + 1),
  }));
  const { api } = makeMockAveApi();
  let listener: ((record: NotificationToastPayload) => void) | undefined;
  let subscribed = false;
  api.onNotificationToast = vi.fn((receive: (record: NotificationToastPayload) => void) => {
    listener = receive;
    if (!subscribed) expect(required(holder.current).getSnapshot().map((record) => record.id)).toEqual([BANNER_ID]);
    subscribed = true;
    for (const record of records) receive(record);
    return () => { listener = undefined; };
  });
  return { api: api as unknown as AveApi, records, deliver: (record: NotificationToastPayload) => required(listener)(record) };
}

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("banner history during retained notification replay", () => {
  it("keeps a current error banner before a full older replay and displays original chronology", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000); // Banner arrival is its registration time, independently of the publication date.
    const holder: HistoryHolder = {};
    const { api, records } = retainedNotices(holder, 1_000);
    render(<NoticeWindow api={api} holder={holder} onAction={vi.fn()} />);

    const expectedIds = [BANNER_ID, ...records.toReversed().map((record) => `notification:${record.id}`)];
    expect(required(holder.current).getSnapshot().map((record) => record.id)).toEqual(expectedIds);
    expect(screen.getByTestId("marketplace-announcement-banner")).toBeVisible();
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("51");
    expect(screen.getByTestId("notification-bell-error")).toHaveClass("bg-destructive");

    fireEvent.click(screen.getByTestId("notification-bell"));
    expect(screen.getAllByTestId("notification-history-row").map((row) => row.getAttribute("data-notice-id"))).toEqual(expectedIds);
    expect(screen.getAllByTestId("notification-history-row")[0]).toHaveTextContent("Maintenance A restart is required");
    expect(screen.queryByTestId("notification-bell-error")).toBeNull();
  });

  it.each(["dismissal", "unmount"] as const)("protects an older showing banner and releases its capacity and saved action after %s", (removal) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const holder: HistoryHolder = {};
    const { api, records, deliver } = retainedNotices(holder, 2_000);
    const onAction = vi.fn();
    const { rerender } = render(<NoticeWindow api={api} holder={holder} onAction={onAction} />);
    const history = required(holder.current);
    const banner = required(history.getSnapshot().find((record) => record.id === BANNER_ID));
    const savedAction = required(banner.actions?.[0]);
    const historyIds = records.toReversed().map((record) => `notification:${record.id}`);
    expect(history.getSnapshot().map((record) => record.id)).toEqual([...historyIds, BANNER_ID]);
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("51");
    expect(screen.getByTestId("notification-bell-error")).toHaveClass("bg-destructive");

    if (removal === "dismissal") fireEvent.click(screen.getByTestId("marketplace-announcement-dismiss"));
    else rerender(<NoticeWindow api={api} holder={holder} onAction={onAction} mounted={false} />);

    expect(screen.queryByTestId("marketplace-announcement-banner")).toBeNull();
    expect(history.getSnapshot().map((record) => record.id)).toEqual(historyIds);
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("50");
    expect(screen.queryByTestId("notification-bell-error")).toBeNull();
    act(() => savedAction.run());
    expect(onAction).not.toHaveBeenCalled();
    act(() => deliver({ id: "after-removal", createdAt: 2_050, kind: "system", title: "Live", body: "After banner removal" }));
    expect(history.getSnapshot().map((record) => record.id)).toEqual(["notification:after-removal", ...historyIds.slice(0, -1)]);
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("50");
  });

  it("keeps a cleared visible banner absent on rerender and disables its action after dismissal", () => {
    const holder: HistoryHolder = {};
    const { api } = makeMockAveApi();
    const onAction = vi.fn();
    const { rerender } = render(<NoticeWindow api={api as unknown as AveApi} holder={holder} onAction={onAction} />);
    const history = required(holder.current);
    const savedAction = required(required(history.getSnapshot()[0]).actions?.[0]);
    fireEvent.click(screen.getByTestId("notification-bell"));
    fireEvent.click(screen.getByTestId("notification-history-clear-all"));
    rerender(<NoticeWindow api={api as unknown as AveApi} holder={holder} onAction={onAction} />);
    expect(history.getSnapshot()).toEqual([]);
    expect(screen.getByTestId("marketplace-announcement-banner")).toBeVisible();
    expect(screen.queryByTestId("notification-bell-count")).toBeNull();

    act(() => savedAction.run());
    expect(onAction).toHaveBeenCalledExactlyOnceWith(required(ANNOUNCEMENT.actions[0]).target);
    fireEvent.click(screen.getByTestId("marketplace-announcement-dismiss"));
    act(() => savedAction.run());
    expect(onAction).toHaveBeenCalledOnce();
    expect(history.getSnapshot()).toEqual([]);
  });

  it("keeps a visible banner protected after effect cleanup and setup replay", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const holder: HistoryHolder = {};
    const { api } = makeMockAveApi();
    let listener: ((record: NotificationToastPayload) => void) | undefined;
    api.onNotificationToast = vi.fn((receive: (record: NotificationToastPayload) => void) => {
      listener = receive;
      return () => { listener = undefined; };
    });
    render(<StrictMode><NoticeWindow api={api as unknown as AveApi} holder={holder} onAction={vi.fn()} /></StrictMode>);
    const history = required(holder.current);
    expect(history.getSnapshot().map((record) => record.id)).toEqual([BANNER_ID]);
    act(() => {
      for (let index = 0; index < 50; index++) required(listener)({
        id: `after-effect-replay:${index}`, createdAt: 2_000 + index,
        kind: "system", title: "Live", body: String(index),
      });
    });
    expect(history.getSnapshot()).toHaveLength(51);
    expect(history.getSnapshot().at(-1)).toMatchObject({ id: BANNER_ID, severity: "error", createdAt: 1_000, announcementId: 1, read: false });
    expect(history.getLatestError()?.message).toBe("Maintenance A restart is required");
    expect(screen.getByTestId("marketplace-announcement-banner")).toBeVisible();
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("51");
    expect(screen.getByTestId("notification-bell-error")).toHaveClass("bg-destructive");
  });

  it("restores an evicted banner snapshot during synchronous retained replay without announcing it twice", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const holder: HistoryHolder = {};
    const { api } = makeMockAveApi();
    const snapshots: (readonly NoticeRecord[])[] = [];
    let original: NoticeRecord | undefined;
    let stopObserving = () => {};
    const payloads: NotificationToastPayload[] = Array.from({ length: 50 }, (_, index) => ({
      id: `strict-retained:${index + 1}`, createdAt: 2_000 + index,
      kind: "system", title: "Historical", body: String(index + 1),
    }));
    api.onNotificationToast = vi.fn((receive: (record: NotificationToastPayload) => void) => {
      const history = required(holder.current);
      if (original === undefined) {
        original = required(history.getSnapshot().find((record) => record.id === BANNER_ID));
        stopObserving = history.subscribe(() => snapshots.push(history.getSnapshot()));
      }
      for (const record of payloads) receive(record);
      return () => {};
    });
    render(<StrictMode><NoticeWindow api={api as unknown as AveApi} holder={holder} onAction={vi.fn()} /></StrictMode>);
    stopObserving();
    const history = required(holder.current);
    const banner = required(history.getSnapshot().find((record) => record.id === BANNER_ID));
    expect(api.onNotificationToast).toHaveBeenCalledTimes(2);
    expect(snapshots.some((records) => records.length === 50 && records.every((record) => record.id !== BANNER_ID))).toBe(true);
    expect(banner).toMatchObject({
      id: BANNER_ID, createdAt: required(original).createdAt, announcementId: 1, read: required(original).read,
    });
    expect(history.getLatestError()?.message).toBe("Maintenance A restart is required");
    const expectedIds = [...payloads.toReversed().map((record) => `notification:${record.id}`), BANNER_ID];
    expect(history.getSnapshot().map((record) => record.id)).toEqual(expectedIds);
    expect(screen.getByTestId("marketplace-announcement-banner")).toBeVisible();
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("51");
    expect(screen.getByTestId("notification-bell-error")).toHaveClass("bg-destructive");
    fireEvent.click(screen.getByTestId("notification-bell"));
    expect(screen.getAllByTestId("notification-history-row").map((row) => row.getAttribute("data-notice-id"))).toEqual(expectedIds);
  });

  it("restores the oldest historical row displaced while a newer banner is temporarily archived", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(2_000);
    const holder: HistoryHolder = {};
    const { api, records } = retainedNotices(holder, 1_000);
    render(<StrictMode><NoticeWindow api={api} holder={holder} onAction={vi.fn()} /></StrictMode>);
    const history = required(holder.current);
    const expectedIds = [BANNER_ID, ...records.toReversed().map((record) => `notification:${record.id}`)];
    expect(api.onNotificationToast).toHaveBeenCalledTimes(2);
    expect(history.getSnapshot().map((record) => record.id)).toEqual(expectedIds);
    expect(history.getSnapshot()[0]).toMatchObject({ id: BANNER_ID, createdAt: 2_000, announcementId: 1, read: false });
    expect(history.getSnapshot().every((record) => !record.read)).toBe(true);
    expect(history.getLatestError()?.message).toBe("Maintenance A restart is required");
    expect(screen.getByTestId("marketplace-announcement-banner")).toBeVisible();
    expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("51");
    expect(screen.getByTestId("notification-bell-error")).toHaveClass("bg-destructive");
    fireEvent.click(screen.getByTestId("notification-bell"));
    expect(screen.getAllByTestId("notification-history-row").map((row) => row.getAttribute("data-notice-id"))).toEqual(expectedIds);
    expect(history.getSnapshot().every((record) => record.read)).toBe(true);
  });
});
