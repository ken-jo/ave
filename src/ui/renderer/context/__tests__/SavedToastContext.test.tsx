// @vitest-environment jsdom
/** The settings "Saved" confirmation is a notice like any other: polite status, one at a time, auto-dismissing. */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAVED_NOTICE_TTL_MS, SavedToastFloating, useSavedNotice } from "../SavedToastContext.js";

function Harness() {
  const { notifySaved, visibleToast, dismiss } = useSavedNotice();
  return (
    <>
      <button type="button" onClick={notifySaved}>save</button>
      <SavedToastFloating toast={visibleToast} onDismiss={dismiss} />
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("settings saved notice", () => {
  it("shows one polite notice however many saves land, and lets it go on its own", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("save"));
    fireEvent.click(screen.getByText("save"));
    const notices = screen.getAllByTestId("status-toast");
    expect(notices).toHaveLength(1);
    expect(screen.getByTestId("notice-live-polite")).toHaveTextContent(notices[0]?.textContent ?? "missing");
    expect(notices[0]?.closest('[data-testid="settings-saved-toast"]')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(SAVED_NOTICE_TTL_MS + 50);
    });
    expect(screen.queryByTestId("status-toast")).toBeNull();
  });
});
