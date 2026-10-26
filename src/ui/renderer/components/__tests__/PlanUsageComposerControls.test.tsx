// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { fakeAppSettings } from "../../../../../test/renderer/fake-app-settings.js";
import { t } from "../../../../i18n/runtime.js";
import type { AppSettings } from "../../types.js";
import { PlanUsageComposerControls } from "../PlanUsageComposerControls.js";

const getSettings = vi.fn();
const updateSettings = vi.fn();
const openExternalUrl = vi.fn(async () => ({ ok: true }));
let broadcast: ((settings: AppSettings) => void) | null = null;
const onSettingsUpdated = vi.fn((cb: (settings: AppSettings) => void) => {
  broadcast = cb;
  return () => { broadcast = null; };
});
let apiReady = true;
vi.mock("../../api-client.js", () => ({
  getApi: () => {
    if (!apiReady) throw new Error("aveApi not initialized");
    return { getSettings, updateSettings, onSettingsUpdated, openExternalUrl };
  },
}));

function planSettings(model: string, speed?: "instant" | "medium" | "high"): AppSettings {
  return fakeAppSettings({
    llm: {
      activeChatRuntime: { kind: "subscription", provider: "chatgpt-plan", model },
      ...(speed ? { subscriptionReasoningSpeed: speed } : {}),
    },
  });
}

/** Radix popovers open on pointerdown. */
function openPicker() {
  fireEvent.pointerDown(screen.getByTestId("iab-status-plan-speed"), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(screen.getByTestId("iab-status-plan-speed"));
  return screen.findByTestId("plan-speed-picker");
}

beforeEach(() => {
  getSettings.mockReset();
  updateSettings.mockReset();
  openExternalUrl.mockClear();
  broadcast = null;
  apiReady = true;
});

describe("PlanUsageComposerControls", () => {
  it("shows Using ChatGPT plan beside the model with the current speed while chat spends the plan", async () => {
    getSettings.mockResolvedValue(planSettings("gpt-6.1-sol"));
    render(<PlanUsageComposerControls />);
    expect(await screen.findByTestId("iab-status-plan-in-use")).toHaveTextContent(t("subscriptionProvidersSection.chatgptPlanInUse"));
    expect(screen.getByTestId("iab-status-plan-speed")).toHaveAttribute("data-speed", "medium");
  });

  it("renders nothing, without throwing, on a surface that has no renderer api", () => {
    apiReady = false;
    const { container } = render(<PlanUsageComposerControls />);
    expect(container).toBeEmptyDOMElement();
    expect(getSettings).not.toHaveBeenCalled();
  });

  it("renders nothing on an API key or the Codex CLI", async () => {
    getSettings.mockResolvedValue(fakeAppSettings({ llm: { activeChatRuntime: { kind: "api" } } }));
    const { container, rerender } = render(<PlanUsageComposerControls />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    getSettings.mockResolvedValue(fakeAppSettings({ llm: { activeChatRuntime: { kind: "subscription", provider: "codex" } } }));
    rerender(<PlanUsageComposerControls key="codex" />);
    await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Instant, Medium and High, saves a pick, and links to Manage usage", async () => {
    getSettings.mockResolvedValue(planSettings("gpt-6.1-sol"));
    updateSettings.mockResolvedValue({ ok: true });
    render(<PlanUsageComposerControls />);
    await screen.findByTestId("iab-status-plan-speed");
    const picker = await openPicker();
    expect(within(picker).getByTestId("plan-speed-option:instant")).toBeInTheDocument();
    expect(within(picker).getByTestId("plan-speed-option:high")).toBeInTheDocument();
    fireEvent.click(within(picker).getByTestId("plan-speed-option:high"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ llm: { subscriptionReasoningSpeed: "high" } }));
    broadcast?.(planSettings("gpt-6.1-sol", "high"));
    await waitFor(() => expect(screen.getByTestId("iab-status-plan-speed")).toHaveAttribute("data-speed", "high"));
    const reopened = await openPicker();
    fireEvent.click(within(reopened).getByTestId("plan-usage-manage"));
    expect(openExternalUrl).toHaveBeenCalledWith("https://chatgpt.com/settings/usage");
  });

  it("says when the model runs a speed at another level instead of clamping it silently", async () => {
    // gpt-6.1-sol accepts low..max but not none, so Instant runs at low.
    getSettings.mockResolvedValue(planSettings("gpt-6.1-sol"));
    render(<PlanUsageComposerControls />);
    await screen.findByTestId("iab-status-plan-speed");
    const picker = await openPicker();
    expect(within(picker).getByTestId("plan-speed-note:instant")).toHaveTextContent(
      t("bottomActionRow.planSpeedRunsAt", { speed: t("bottomActionRow.planSpeedInstant"), effort: "low" }),
    );
    expect(within(picker).queryByTestId("plan-speed-note:medium")).not.toBeInTheDocument();
    expect(within(picker).queryByTestId("plan-speed-note:high")).not.toBeInTheDocument();
  });

  it("says the speed does not apply to a model that takes no reasoning setting", async () => {
    getSettings.mockResolvedValue(planSettings("gpt-4o"));
    render(<PlanUsageComposerControls />);
    await screen.findByTestId("iab-status-plan-speed");
    const picker = await openPicker();
    expect(within(picker).getByTestId("plan-speed-note:medium")).toHaveTextContent(t("bottomActionRow.planSpeedNotApplicable"));
  });
});
