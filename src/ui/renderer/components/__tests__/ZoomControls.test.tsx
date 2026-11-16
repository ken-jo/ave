import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ZoomControls, ZoomIndicator } from "../ZoomControls.js";
import { rendererShortcutPlatform } from "../../hooks/use-shortcuts.js";
import { defaultAccelerator, formatAccelerator } from "../../../../shared/shortcuts.js";
import { t } from "../../../../i18n/runtime.js";

vi.mock("../../theme/index.js", () => ({ useTheme: () => ({ appearance: { zoomLevel: 0 } }) }));
vi.mock("../../theme/ThemeProvider.js", () => ({ useOptionalTheme: () => ({ appearance: { zoomLevel: 1 } }) }));
vi.mock("../../api-client.js", () => ({ getApi: () => ({ updateSettings: vi.fn(async () => ({ ok: true })) }) }));
vi.mock("../../hooks/use-shortcuts.js", () => ({ rendererShortcutPlatform: vi.fn(() => "darwin") }));

afterEach(() => vi.clearAllMocks());

describe("ZoomControls keyboard hint locale", () => {
  it.each(["darwin", "other"] as const)("names shortcuts in %s platform vocabulary", (platform) => {
    vi.mocked(rendererShortcutPlatform).mockReturnValue(platform);
    const view = render(<ZoomControls />);
    for (const [id, label] of [["menu.zoomOut", "be_main.menuZoomOut"], ["menu.zoomIn", "be_main.menuZoomIn"], ["menu.resetZoom", "be_main.menuResetZoom"]] as const) {
      const shortcut = formatAccelerator(defaultAccelerator(id, platform)!, platform);
      expect(view.getByRole("button", { name: t("appearanceTab.shortcutLabel", { label: t(label), shortcut }) })).toBeInTheDocument();
    }
    expect(view.container.textContent).not.toContain("Cmd/Ctrl");
    for (const button of view.getAllByRole("button")) expect(button.getAttribute("aria-label")).not.toContain("Cmd/Ctrl");
  });

  it("formats the status indicator shortcuts for the active platform", () => {
    vi.mocked(rendererShortcutPlatform).mockReturnValue("darwin");
    const view = render(<ZoomIndicator />);
    expect(view.getByTestId("zoom-indicator").getAttribute("aria-label")).toContain("⌘");
    expect(view.getByTestId("zoom-indicator").getAttribute("aria-label")).not.toContain("Cmd/Ctrl");
  });
});
