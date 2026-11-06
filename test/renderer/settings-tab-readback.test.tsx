import { ThemeProvider } from "../../src/ui/renderer/theme/ThemeProvider.js";
import { DEFAULT_APPEARANCE } from "../../src/shared/appearance-settings.js";
// Panel tab changes must report to the embedding consumer without an unstable feedback loop.
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { DEFAULT_APP_INFO, makeMockAveApi, makeMockAveNamespace } from "./mock-ave-api.js";
import { activeSettingsTab, clickSettingsTab, settingsTabTrigger } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Embedder = "content" | "inline";

async function renderWithConsumer(embedder: Embedder) {
  const { api } = makeMockAveApi();
  vi.stubGlobal("ave", makeMockAveNamespace().ns);
  vi.stubGlobal("aveApi", api);
  (window as unknown as { aveApi: typeof api }).aveApi = api;

  const { SettingsContent } = await import("../../src/ui/renderer/SettingsContent.js");
  const { SettingsInlineView } = await import("../../src/ui/renderer/SettingsInlineView.js");
  const { TooltipProvider } = await import("../../src/components/ui/tooltip.js");

  // Model the app's controlled tab seed and read-back state.
  function Consumer() {
    const [settingsTab, setSettingsTab] = useState("llm");
    return (
      <ThemeProvider initialAppearance={DEFAULT_APPEARANCE}><TooltipProvider>
        <div data-testid="consumer-tab">{settingsTab}</div>
        {embedder === "content" ? (
          <SettingsContent
            api={api as never}

            onSaved={() => {}}
            initialTab={settingsTab}
            onTabChange={setSettingsTab}
          />
        ) : (
          <SettingsInlineView
            api={api as never}

            onSaved={() => {}}
            initialTab={settingsTab}
            onTabChange={setSettingsTab}
          />
        )}
      </TooltipProvider></ThemeProvider>
    );
  }

  const result = render(<Consumer />);
  await waitFor(() => expect(settingsTabTrigger(result.container, "permissions")).toBeTruthy());
  return { ...result, api };
}

function consumerTab(container: HTMLElement): string {
  return container.querySelector('[data-testid="consumer-tab"]')?.textContent ?? "";
}

describe("settings navigation footer", () => {
  it("names the version main reports, not a literal typed at some release", async () => {
    const { container, api } = await renderWithConsumer("content");
    const footer = container.querySelector('[data-testid="settings-nav-app-version"]');
    expect(footer).toBeTruthy();
    await waitFor(() => expect(footer?.textContent).toBe(`v${DEFAULT_APP_INFO.version}`));
    expect(api.getAppInfo).toHaveBeenCalled();
  });
});

describe.each<Embedder>(["content", "inline"])("settings tab read-back (%s)", (embedder) => {
  it("hands the new tab to the consumer when the user moves inside the panel", async () => {
    const { container } = await renderWithConsumer(embedder);

    expect(consumerTab(container)).toBe("llm");
    expect(activeSettingsTab(container)).toBe("llm");

    clickSettingsTab(container, "permissions");

    // Assert the outside state so a panel-only navigation cannot hide missing read-back.
    await waitFor(() => expect(consumerTab(container)).toBe("permissions"));
  });

  it("does not bounce the selection when the consumer echoes the value back as the seed", async () => {
    const { container } = await renderWithConsumer(embedder);

    clickSettingsTab(container, "permissions");
    await waitFor(() => expect(consumerTab(container)).toBe("permissions"));

    // Feeding read-back into initialTab must not reset or oscillate the selection.
    await waitFor(() => expect(activeSettingsTab(container)).toBe("permissions"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activeSettingsTab(container)).toBe("permissions");
    expect(consumerTab(container)).toBe("permissions");
  });

  it("also reports a move the panel makes on the user's behalf", async () => {
    const { container } = await renderWithConsumer(embedder);

    // Internal marketplace links must report tab changes too.
    const marketplaceButton = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-testid="llm-tab:marketplace-providers"]');
      if (!el) throw new Error("marketplace affordance not rendered");
      return el;
    });
    fireEvent.click(marketplaceButton);

    await waitFor(() => expect(consumerTab(container)).toBe("marketplace"));
    expect(activeSettingsTab(container)).toBe("marketplace");
  });
});


it("exposes search results as list buttons and announces their count", async () => {
  const { container, getByRole } = await renderWithConsumer("content");
  fireEvent.change(getByRole("searchbox"), { target: { value: "터미널" } });
  const results = getByRole("list", { name: "설정 검색" }).querySelectorAll("li > button");
  expect(results.length).toBeGreaterThan(0);
  expect(container.querySelector('[role="listitem"]')).toBeNull();
  const announcement = container.querySelector('[role="status"][aria-live="polite"][aria-atomic="true"]');
  expect(announcement?.textContent).toBe(`설정 ${results.length}개 검색됨`);
  fireEvent.change(getByRole("searchbox"), { target: { value: "unmatchable search phrase" } });
  expect(announcement?.textContent).toBe("설정 0개 검색됨");
});
