// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";
import type { DocumentEngineApi } from "../../../../shared/document-engine-api.js";
import type { DocumentEngineInstallationState } from "../../../../shared/document-engine.js";
import type { MarketplaceAnnouncement } from "../../../../shared/marketplace-announcements.js";
import { deferred } from "../../../../__tests__/support/deferred.js";
import { NotificationHistoryContext } from "../../context/NotificationHistoryContext.js";
import { createNotificationHistory, notificationCounts } from "../../notification-history.js";
import { DeprecatedModelNotice, RetiredProviderNotice } from "../RetiredProviderNotice.js";
import { MarketplaceAnnouncementBanner } from "../MarketplaceAnnouncementBanner.js";
import { DocumentEngineInstallContent } from "../DocumentEngineInstallContent.js";

const RETIRED_ROUTE = { vendor: "openai", model: "retired-model", reason: "unlisted" } as const;
const ABSENT: DocumentEngineInstallationState = {
  phase: "absent", version: "26.8.1", downloadBytes: 1024, downloadedBytes: 0, installedBytes: 2048,
};
let previousLocale: ReturnType<typeof getLocale>;
beforeEach(() => { previousLocale = getLocale(); setLocale("en"); });
afterEach(() => { cleanup(); setLocale(previousLocale); });

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a banner history value");
  return value;
}

function installation(state = ABSENT) {
  return {
    status: vi.fn(async () => ({ ok: true as const, state })),
    install: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(async () => ({ ok: true as const })),
    uninstall: vi.fn(async () => ({ ok: true as const })),
  } satisfies DocumentEngineApi;
}

describe("banner notification history", () => {
  it("keeps the retired-route banner in place and mirrors its message and navigation action", () => {
    const history = createNotificationHistory();
    const onChooseProvider = vi.fn();
    render(<NotificationHistoryContext.Provider value={history}>
      <RetiredProviderNotice retiredProvider={RETIRED_ROUTE} onChooseProvider={onChooseProvider} />
    </NotificationHistoryContext.Provider>);
    const banner = screen.getByTestId("retired-provider-notice");
    const title = t("app.retiredModelNoticeTitle", { model: RETIRED_ROUTE.model });
    const body = t("app.retiredModelNoticeBodyUnlisted");
    expect(banner).not.toHaveAttribute("role");
    expect(banner).not.toHaveAttribute("aria-live");
    expect(banner).toHaveTextContent(title);
    expect(banner).toHaveTextContent(body);
    expect(history.getSnapshot()).toHaveLength(1);
    const record = required(history.getSnapshot()[0]);
    expect(record).toMatchObject({ message: `${title} ${body}`, severity: "warning", source: "banner", read: false });
    expect(record.actions?.[0]?.label).toBe(screen.getByTestId("retired-provider-notice-action").textContent);
    expect(onChooseProvider).not.toHaveBeenCalled();
    act(() => required(record.actions?.[0]).run());
    fireEvent.click(screen.getByTestId("retired-provider-notice-action"));
    expect(onChooseProvider).toHaveBeenCalledTimes(2);
  });

  it("uses the latest banner callback without changing its read count or arrival time", () => {
    const history = createNotificationHistory();
    const firstChoice = vi.fn();
    const nextChoice = vi.fn();
    const { rerender } = render(<NotificationHistoryContext.Provider value={history}>
      <RetiredProviderNotice retiredProvider={RETIRED_ROUTE} onChooseProvider={firstChoice} />
    </NotificationHistoryContext.Provider>);
    const record = required(history.getSnapshot()[0]);
    act(() => history.markRead());
    rerender(<NotificationHistoryContext.Provider value={history}>
      <RetiredProviderNotice retiredProvider={RETIRED_ROUTE} onChooseProvider={nextChoice} />
    </NotificationHistoryContext.Provider>);
    expect(history.getSnapshot()).toHaveLength(1);
    expect(history.getSnapshot()[0]).toMatchObject({ id: record.id, createdAt: record.createdAt, read: true });
    expect(notificationCounts(history.getSnapshot(), 0).total).toBe(0);
    act(() => required(record.actions?.[0]).run());
    expect(firstChoice).not.toHaveBeenCalled();
    expect(nextChoice).toHaveBeenCalledOnce();
  });

  it("does not redirect an older banner occurrence's saved action to a replacement occurrence", () => {
    const history = createNotificationHistory();
    const firstChoice = vi.fn();
    const nextChoice = vi.fn();
    const { rerender } = render(<NotificationHistoryContext.Provider value={history}>
      <RetiredProviderNotice retiredProvider={RETIRED_ROUTE} onChooseProvider={firstChoice} />
    </NotificationHistoryContext.Provider>);
    const previousAction = required(required(history.getSnapshot()[0]).actions?.[0]);
    rerender(<NotificationHistoryContext.Provider value={history}>
      <RetiredProviderNotice retiredProvider={{ ...RETIRED_ROUTE, model: "replacement-retired-model" }} onChooseProvider={nextChoice} />
    </NotificationHistoryContext.Provider>);
    act(() => previousAction.run());
    expect(firstChoice).not.toHaveBeenCalled();
    expect(nextChoice).not.toHaveBeenCalled();
    act(() => required(required(history.getSnapshot()[0]).actions?.[0]).run());
    expect(nextChoice).toHaveBeenCalledOnce();
  });

  it("clears only history and does not reinsert an unchanged visible banner on rerender", () => {
    const history = createNotificationHistory();
    const { rerender } = render(<NotificationHistoryContext.Provider value={history}>
      <RetiredProviderNotice retiredProvider={RETIRED_ROUTE} onChooseProvider={vi.fn()} />
    </NotificationHistoryContext.Provider>);
    act(() => history.clear(required(history.getSnapshot()[0]).id));
    expect(screen.getByTestId("retired-provider-notice")).toBeVisible();
    rerender(<NotificationHistoryContext.Provider value={history}>
      <RetiredProviderNotice retiredProvider={RETIRED_ROUTE} onChooseProvider={vi.fn()} />
    </NotificationHistoryContext.Provider>);
    expect(history.getSnapshot()).toEqual([]);
    expect(screen.getByTestId("retired-provider-notice")).toBeVisible();
  });

  it("mirrors a deprecated-model banner and keeps its history after dismissal", () => {
    const history = createNotificationHistory();
    const onChooseModel = vi.fn();
    render(<NotificationHistoryContext.Provider value={history}>
      <DeprecatedModelNotice model="retiring-model" onChooseModel={onChooseModel} />
    </NotificationHistoryContext.Provider>);
    const banner = screen.getByTestId("deprecated-model-notice");
    const record = required(history.getSnapshot()[0]);
    expect(banner).not.toHaveAttribute("role");
    expect(banner).not.toHaveAttribute("aria-live");
    expect(banner).toHaveTextContent(t("app.deprecatedModelNoticeTitle", { model: "retiring-model" }));
    expect(record).toMatchObject({
      severity: "info", source: "banner",
      message: `${t("app.deprecatedModelNoticeTitle", { model: "retiring-model" })} ${t("app.deprecatedModelNoticeBody")}`,
    });
    expect(record.actions?.[0]?.label).toBe(screen.getByTestId("deprecated-model-notice-action").textContent);
    act(() => required(record.actions?.[0]).run());
    expect(onChooseModel).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("deprecated-model-notice-dismiss"));
    expect(screen.queryByTestId("deprecated-model-notice")).toBeNull();
    expect(history.getSnapshot()[0]).toMatchObject({ id: record.id, message: record.message, actions: [] });
    act(() => required(record.actions?.[0]).run());
    expect(onChooseModel).toHaveBeenCalledOnce();
  });

  it("mirrors the visible announcement's severity and every action without listing queued announcements", () => {
    const history = createNotificationHistory();
    const onAction = vi.fn();
    const current: MarketplaceAnnouncement = {
      id: 10, title: "Maintenance", body: "A restart is required", level: "critical",
      createdAt: "2026-11-09T00:00:00Z", startsAt: null, endsAt: null,
      actions: [
        { label: { en: "Open settings", ko: "설정 열기" }, target: { kind: "settings", settingsTab: "permissions" } },
        { label: { en: "Details", ko: "자세히" }, target: { kind: "url", url: "https://example.com/maintenance" } },
      ],
    };
    const older = { ...current, id: 9, title: "Earlier announcement" };
    const { rerender } = render(<NotificationHistoryContext.Provider value={history}>
      <MarketplaceAnnouncementBanner announcements={[current, older]} onDismiss={vi.fn()} onAction={onAction} />
    </NotificationHistoryContext.Provider>);
    expect(screen.getByTestId("marketplace-announcement-banner")).toBeVisible();
    expect(screen.getByTestId("marketplace-announcement-banner")).not.toHaveAttribute("role");
    expect(screen.getByTestId("marketplace-announcement-banner")).not.toHaveAttribute("aria-live");
    expect(history.getSnapshot()).toHaveLength(1);
    const record = required(history.getSnapshot()[0]);
    expect(record).toMatchObject({ message: "Maintenance A restart is required", severity: "error", source: "banner" });
    expect(notificationCounts(history.getSnapshot(), 0)).toMatchObject({ unread: 1, error: true });
    expect(record.actions).toHaveLength(2);
    for (const [index, action] of required(record.actions).entries()) {
      expect(action.label).toBe(screen.getByTestId(`marketplace-announcement-action-${index}`).textContent);
      act(() => action.run());
      expect(onAction).toHaveBeenLastCalledWith(required(current.actions[index]).target);
    }
    fireEvent.click(screen.getByTestId("marketplace-announcement-action-0"));
    expect(onAction).toHaveBeenLastCalledWith(required(current.actions[0]).target);
    rerender(<NotificationHistoryContext.Provider value={history}>
      <MarketplaceAnnouncementBanner announcements={[]} onDismiss={vi.fn()} onAction={onAction} />
    </NotificationHistoryContext.Provider>);
    expect(screen.queryByTestId("marketplace-announcement-banner")).toBeNull();
    expect(history.getSnapshot()[0]).toMatchObject({ id: record.id, message: record.message });
  });

  it("does not reuse a saved announcement action for a different target with the same label", () => {
    const history = createNotificationHistory();
    const onAction = vi.fn();
    const announcement: MarketplaceAnnouncement = {
      id: 20, title: "Guide", body: "Read the guide", level: "info",
      createdAt: "2026-11-09T00:00:00Z", startsAt: null, endsAt: null,
      actions: [{ label: { en: "Details", ko: "자세히" }, target: { kind: "url", url: "https://example.com/earlier-guide" } }],
    };
    const { rerender } = render(<NotificationHistoryContext.Provider value={history}>
      <MarketplaceAnnouncementBanner announcements={[announcement]} onDismiss={vi.fn()} onAction={onAction} />
    </NotificationHistoryContext.Provider>);
    const record = required(history.getSnapshot()[0]);
    const oldAction = required(record.actions?.[0]);
    act(() => history.markRead());
    const replacement = { ...announcement, actions: [{ ...required(announcement.actions[0]), target: { kind: "url" as const, url: "https://example.com/current-guide" } }] };
    rerender(<NotificationHistoryContext.Provider value={history}>
      <MarketplaceAnnouncementBanner announcements={[replacement]} onDismiss={vi.fn()} onAction={onAction} />
    </NotificationHistoryContext.Provider>);
    act(() => oldAction.run());
    expect(onAction).not.toHaveBeenCalled();
    act(() => required(required(history.getSnapshot()[0]).actions?.[0]).run());
    expect(onAction).toHaveBeenCalledExactlyOnceWith(required(replacement.actions[0]).target);
    expect(history.getSnapshot()[0]).toMatchObject({ id: record.id, createdAt: record.createdAt, read: true });
  });

  it("does not reinterpret a saved document install action as uninstall after the engine becomes ready", async () => {
    const history = createNotificationHistory();
    const api = installation();
    render(<NotificationHistoryContext.Provider value={history}>
      <DocumentEngineInstallContent api={api} onDismiss={vi.fn()} />
    </NotificationHistoryContext.Provider>);
    const installButton = await screen.findByRole("button", { name: t("documentEngine.install") });
    await waitFor(() => expect(installButton).toBeEnabled());
    const installAction = required(required(history.getSnapshot()[0]).actions?.[0]);
    api.status.mockResolvedValueOnce({ ok: true, state: { ...ABSENT, phase: "ready" } });
    fireEvent.click(installButton);
    await waitFor(() => expect(screen.getByRole("button", { name: t("documentEngine.uninstall") })).toBeEnabled());
    act(() => installAction.run());
    expect(api.install).toHaveBeenCalledOnce();
    expect(api.uninstall).not.toHaveBeenCalled();
    act(() => required(required(history.getSnapshot()[0]).actions?.[0]).run());
    await waitFor(() => expect(api.uninstall).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("button", { name: t("documentEngine.install") })).toBeEnabled());
  });

  it("mirrors the install action and disables it in both places while an installation is in flight", async () => {
    const history = createNotificationHistory();
    const api = installation();
    const pending = deferred<Awaited<ReturnType<DocumentEngineApi["install"]>>>();
    api.install.mockReturnValueOnce(pending.promise as never);
    render(<NotificationHistoryContext.Provider value={history}>
      <DocumentEngineInstallContent api={api} onDismiss={vi.fn()} />
    </NotificationHistoryContext.Provider>);
    const button = await screen.findByRole("button", { name: t("documentEngine.install") });
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByTestId("document-engine-install")).toBeVisible();
    const record = required(history.getSnapshot()[0]);
    expect(record).toMatchObject({ source: "banner", severity: "info" });
    expect(record.message).toContain(t("documentEngine.title"));
    expect(record.message).toContain(t("documentEngine.description"));
    expect(record.actions?.[0]).toMatchObject({ label: button.textContent, disabled: false });
    expect(api.install).not.toHaveBeenCalled();
    act(() => { history.markRead(); required(record.actions?.[0]).run(); });
    expect(api.install).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(history.getSnapshot()[0]?.actions?.[0]?.disabled).toBe(true);
    act(() => required(record.actions?.[0]).run());
    expect(api.install).toHaveBeenCalledOnce();
    expect(notificationCounts(history.getSnapshot(), 0).unread).toBe(0);
    await act(async () => pending.resolve({ ok: true }));
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(api.install).toHaveBeenCalledTimes(2));
  });

  it("leaves document installation history after unmount and removes its executable action", async () => {
    const history = createNotificationHistory();
    const api = installation();
    const { unmount } = render(<NotificationHistoryContext.Provider value={history}>
      <DocumentEngineInstallContent api={api} onDismiss={vi.fn()} />
    </NotificationHistoryContext.Provider>);
    await waitFor(() => expect(screen.getByRole("button", { name: t("documentEngine.install") })).toBeEnabled());
    const record = required(history.getSnapshot()[0]);
    const runInstall = required(record.actions?.[0]).run;
    unmount();
    expect(history.getSnapshot()[0]).toMatchObject({ id: record.id, message: record.message, actions: [] });
    act(() => runInstall());
    expect(api.install).not.toHaveBeenCalled();
  });

  it("keeps unsupported installation actions disabled in the banner and history", async () => {
    const history = createNotificationHistory();
    const api = installation({ ...ABSENT, phase: "unsupported", error: "unsupported-platform" });
    render(<NotificationHistoryContext.Provider value={history}>
      <DocumentEngineInstallContent api={api} onDismiss={vi.fn()} />
    </NotificationHistoryContext.Provider>);
    const button = await screen.findByRole("button", { name: t("documentEngine.retry") });
    await waitFor(() => expect(history.getSnapshot()[0]?.actions?.[0]?.label).toBe(button.textContent));
    expect(button).toBeDisabled();
    expect(screen.getByTestId("document-engine-install").querySelector('[role="alert"], [role="status"], [aria-live]')).toBeNull();
    const record = required(history.getSnapshot()[0]);
    expect(record.actions?.[0]).toMatchObject({ label: button.textContent, disabled: true });
    act(() => required(record.actions?.[0]).run());
    expect(api.install).not.toHaveBeenCalled();
    expect(notificationCounts(history.getSnapshot(), 0).error).toBe(true);
  });

  it("does not record the settings installation panel as a window banner", async () => {
    const history = createNotificationHistory();
    render(<NotificationHistoryContext.Provider value={history}>
      <DocumentEngineInstallContent api={installation()} />
    </NotificationHistoryContext.Provider>);
    await waitFor(() => expect(screen.getByRole("button", { name: t("documentEngine.install") })).toBeEnabled());
    expect(screen.getByTestId("document-engine-install")).toBeVisible();
    expect(history.getSnapshot()).toEqual([]);
  });
});
