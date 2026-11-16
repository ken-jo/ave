// @vitest-environment jsdom
/** "Show hidden notices again" undoes every "Don't show again", and says there is nothing to undo when nothing is hidden. */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HiddenNoticesReset } from "../HiddenNoticesReset.js";
import { useStatusNotices } from "../../hooks/use-status-bar.js";
import { filterRenderedSettings } from "../../settings-search.js";
import { getLocale, setLocale } from "../../../../i18n/index.js";

afterEach(() => {
  window.localStorage.removeItem("ave.notices.suppressed");
});

describe("HiddenNoticesReset", () => {
  it("is disabled while nothing is hidden", () => {
    render(<HiddenNoticesReset />);
    expect(screen.getByTestId("show-hidden-notices")).toBeDisabled();
  });

  it("brings a silenced notice kind back", () => {
    const { result } = renderHook(() => useStatusNotices());
    act(() => {
      result.current.suppressToastKind("repeat");
    });
    render(<HiddenNoticesReset />);
    const reset = screen.getByTestId("show-hidden-notices");
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(reset).toBeDisabled();
    act(() => {
      result.current.pushToast({ severity: "info", message: "repeat again", kind: "repeat", suppressible: true });
    });
    expect(result.current.visibleToast?.message).toBe("repeat again");
  });

  it("enables itself when Don't show again is pressed elsewhere while Settings is open", () => {
    render(<HiddenNoticesReset />);
    const reset = screen.getByTestId("show-hidden-notices");
    expect(reset).toBeDisabled();
    const { result } = renderHook(() => useStatusNotices());
    act(() => {
      result.current.suppressToastKind("repeat");
    });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    expect(reset).toBeDisabled();
  });

  it("is found from its rendered label in both locales", () => {
    const previous = getLocale();
    try {
      for (const [locale, query] of [["en", "show hidden notices"], ["ko", "숨긴 알림"]] as const) {
        setLocale(locale);
        const view = render(<div data-settings-panel="notifications"><section data-settings-section="notifications-notices"><HiddenNoticesReset /></section></div>);
        expect(filterRenderedSettings(view.container, query).map((match) => match.section.dataset.settingsSection)).toContain("notifications-notices");
        view.unmount();
      }
    } finally { setLocale(previous); }
  });
});
