import "../../../../test/renderer/setup.js";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { MOCK_DEFAULT_SESSION_ID, MOCK_DEFAULT_SETTINGS } from "../../../../test/renderer/mock-ave-api.js";
import { browserControlFixture } from "../../../__tests__/support/browser-control-fixture.js";
import type { BrowserTabsApi } from "../../../shared/browser-surface.js";
import type { AvePreviewApi } from "../types.js";
import { t } from "../../../i18n/runtime.js";

afterEach(() => vi.restoreAllMocks());

describe("retained main browser preview activation", () => {
  it.each(["click", "Enter"])("opens an agent-used retained surface without an assigned pane using %s", async (activation) => {
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-pip-region") || this.querySelector("[data-pip-region]")
        ? new DOMRect(10, 100, 1000, 650) : originalBounds.call(this);
    });
    const tabId = "browser:abc12345-1";
    const surface = { kind: "browser", tabId, ordinal: 1, url: "https://example.test/retained", cwd: null, projectRoot: process.cwd() };
    const { container, api } = await renderApp({ hasApiKey: true, browserTabs: true,
      sessions: [{ id: MOCK_DEFAULT_SESSION_ID, modifiedAt: new Date().toISOString(), title: "Retained browser conversation" }],
      workspaceRoots: [{ path: process.cwd(), isDefault: true }], settings: { ...MOCK_DEFAULT_SETTINGS, system: { mainLayout: {
        version: 2, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main", surfaces: { main: surface }, openSurfaces: [surface], panelOpenIds: [], sideTabs: {},
      } } },
    });
    await waitFor(() => expect(document.querySelector(`webview[data-tab-id="${tabId}"]`)).not.toBeNull());
    const guest = document.querySelector(`webview[data-tab-id="${tabId}"]`);
    fireEvent.click(container.querySelector(`[data-testid="sidebar-session-${MOCK_DEFAULT_SESSION_ID}"]`) as HTMLElement);
    await waitFor(() => expect(container.querySelector('[data-testid="web-panel"]')).toBeNull());
    const controls = api.browserTabs as unknown as BrowserTabsApi;
    const control = vi.mocked(controls.onControl).mock.calls.at(-1)?.[0];
    const observe = vi.mocked(window.ave.preview.onAgentObservation).mock.calls[0]?.[0] as Parameters<AvePreviewApi["onAgentObservation"]>[0];
    if (!control || !observe) throw new Error("Browser subscriptions missing");
    act(() => {
      control(browserControlFixture([tabId], "agent-active", 100));
      observe([{ source: "browser", actor: "agent", sessionId: "fixture-session", seq: 1, ts: 1,
        target: { id: "retained-target", path: "browser", hostSessionId: MOCK_DEFAULT_SESSION_ID }, kind: "action", before: null,
        after: { action: "snapshot", tabId: `handle-${tabId}`, rendererTabId: tabId, title: "Retained page", url: surface.url } }]);
    });
    const button = await within(container).findByRole("button", { name: t("agentBrowser.openPreview", { title: "Retained page" }) });
    expect(container.querySelector('[data-testid="web-panel"]')).toBeNull();
    if (activation === "click") fireEvent.click(button);
    else { button.focus(); const { userEvent } = await import("@testing-library/user-event"); await userEvent.setup().keyboard("{Enter}"); }
    await waitFor(() => expect(container.querySelector('[data-testid="web-panel"]')).toHaveAttribute("data-tab-id", tabId));
    expect(document.querySelector(`webview[data-tab-id="${tabId}"]`)).toBe(guest);
  });
});
