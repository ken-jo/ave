import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import type { MarketplaceAnnouncement } from "../../src/shared/marketplace-announcements.js";

// Marketplace announcements are untrusted content: actions may navigate, never change configuration.
describe("marketplace announcement actions", () => {
  afterEach(() => vi.restoreAllMocks());

  function announcement(
    actions: MarketplaceAnnouncement["actions"],
  ): MarketplaceAnnouncement {
    return {
      id: 1,
      title: "OS tool sandbox",
      body: "Shell tools can now run inside a sandbox.",
      level: "info",
      createdAt: "2026-09-03T00:00:00Z",
      startsAt: null,
      endsAt: null,
      actions,
    };
  }

  async function pushAnnouncement(
    api: Awaited<ReturnType<typeof renderApp>>["api"],
    item: MarketplaceAnnouncement,
  ) {
    const listener = api.onMarketplaceAnnouncements.mock.calls[0]?.[0] as
      | ((items: MarketplaceAnnouncement[]) => void)
      | undefined;
    expect(listener).toBeDefined();
    await act(async () => {
      listener!([item]);
    });
  }

  it("takes the user to the settings tab and writes no settings", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    api.updateSettings.mockClear();

    await pushAnnouncement(
      api,
      announcement([
        {
          label: { ko: "샌드박스 설정 열기", en: "Open sandbox settings" },
          target: { kind: "settings", settingsTab: "permissions" },
        },
      ]),
    );

    const button = await waitFor(() => {
      const el = container.querySelector('[data-testid="marketplace-announcement-action-0"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    await act(async () => {
      button.click();
    });

    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="view-path-current-settings:permissions"]'),
      ).not.toBeNull();
    });
    // Assert no configuration writes or browser navigation after the settings route opens.
    expect(
      api.updateSettings.mock.calls.some(([patch]) =>
        Object.prototype.hasOwnProperty.call(patch as object, "permissions"),
      ),
    ).toBe(false);
    expect(api.openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens a url action through the external-url sink and writes no settings", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    api.updateSettings.mockClear();

    await pushAnnouncement(
      api,
      announcement([
        {
          label: { ko: "안내 문서", en: "Read the guide" },
          target: { kind: "url", url: "https://example.com/guide" },
        },
      ]),
    );

    const button = await waitFor(() => {
      const el = container.querySelector('[data-testid="marketplace-announcement-action-0"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });
    await act(async () => {
      button.click();
    });

    expect(api.openExternalUrl).toHaveBeenCalledWith("https://example.com/guide");
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
});
