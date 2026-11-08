import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { AccessibilitySignalsSettings } from "../AccessibilitySignalsSettings.js";
import { AccessibilitySignalEngine, setAccessibilitySignalEngineForTest } from "../../accessibility-signal-engine.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";
import { searchSettings } from "../../settings-search.js";
import { t } from "../../../../i18n/index.js";
import { en as englishMessages } from "../../../../i18n/messages/en.js";
import { ko as koreanMessages } from "../../../../i18n/messages/ko.js";

function install(system: Record<string, unknown> = {}) {
  const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, system } });
  window.aveApi = api as never;
  const play = vi.fn(async () => {});
  setAccessibilitySignalEngineForTest(new AccessibilitySignalEngine({ isWindowFocused: () => true, play }));
  return { api, update: vi.spyOn(api, "updateSettings"), play };
}

afterEach(() => setAccessibilitySignalEngineForTest(null));

const mode = (view: ReturnType<typeof render>, id: string) => view.getByTestId(`accessibility-signal-mode:${id}`) as HTMLSelectElement;

describe("accessibility signal settings", () => {
  it("shows the stored modes, with the shipped defaults for an older profile", async () => {
    install({ signalTurnFailed: "on" });
    const view = render(<AccessibilitySignalsSettings />);
    await waitFor(() => expect(mode(view, "turnFinished")).toBeEnabled());
    expect(mode(view, "turnFinished").value).toBe("unfocused");
    expect(mode(view, "approvalNeeded").value).toBe("unfocused");
    expect(mode(view, "turnFailed").value).toBe("on");
  });

  it("persists a changed mode through the user settings and keeps the others", async () => {
    const { api, update } = install();
    const view = render(<AccessibilitySignalsSettings />);
    await waitFor(() => expect(mode(view, "approvalNeeded")).toBeEnabled());
    fireEvent.change(mode(view, "approvalNeeded"), { target: { value: "off" } });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ system: { signalApprovalNeeded: "off" } }));
    await waitFor(() => expect(mode(view, "approvalNeeded").value).toBe("off"));
    expect(mode(view, "turnFinished").value).toBe("unfocused");
    expect((await api.getSettings()).system).toMatchObject({ signalApprovalNeeded: "off" });
  });

  it("reports a failed save", async () => {
    const { update } = install();
    update.mockResolvedValueOnce({ ok: false, error: "settings-write-failed" } as never);
    const view = render(<AccessibilitySignalsSettings />);
    await waitFor(() => expect(mode(view, "turnFinished")).toBeEnabled());
    fireEvent.change(mode(view, "turnFinished"), { target: { value: "on" } });
    expect(await view.findByRole("alert")).toHaveTextContent(t("accessibilitySignals.saveFailed"));
  });

  it("plays each signal's preview even when the signal is off and the window has focus", async () => {
    const { play } = install({ signalTurnFailed: "off" });
    const view = render(<AccessibilitySignalsSettings />);
    fireEvent.click(view.getByTestId("accessibility-signal-play:turnFailed"));
    fireEvent.click(view.getByTestId("accessibility-signal-play:approvalNeeded"));
    expect(play.mock.calls).toEqual([["turnFailed"], ["approvalNeeded"]]);
  });

  it("says so when a preview cannot play", async () => {
    const { play } = install();
    play.mockRejectedValueOnce(new Error("audio context is suspended"));
    const view = render(<AccessibilitySignalsSettings />);
    fireEvent.click(view.getByTestId("accessibility-signal-play:turnFinished"));
    const alert = await view.findByRole("alert");
    expect(alert).toHaveTextContent(t("accessibilitySignals.playFailed"));
    expect(view.getByTestId("accessibility-signal:turnFinished")).toContainElement(alert);
  });

  it("is found by settings search in both locales", () => {
    const tr = (messages: Record<string, string>) => (key: string) => messages[key] ?? key;
    for (const query of ["sound", "chime", "turn failed", "unfocused"]) {
      expect(searchSettings(query, tr(englishMessages)).map((r) => r.section)).toContain("chat-signals");
    }
    for (const query of ["소리", "알림음", "결정 필요"]) {
      expect(searchSettings(query, tr(koreanMessages)).map((r) => r.section)).toContain("chat-signals");
    }
  });
});
