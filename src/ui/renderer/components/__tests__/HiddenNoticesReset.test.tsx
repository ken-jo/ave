// @vitest-environment jsdom
/** "Show hidden notices again" undoes every "Don't show again", and says there is nothing to undo when nothing is hidden. */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HiddenNoticesReset } from "../HiddenNoticesReset.js";
import { useStatusNotices } from "../../hooks/use-status-bar.js";
import { searchSettings } from "../../settings-search.js";
import { en as englishMessages } from "../../../../i18n/messages/en.js";
import { ko as koreanMessages } from "../../../../i18n/messages/ko.js";

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

  it("is found by settings search in both locales", () => {
    const en: Record<string, string> = englishMessages;
    const ko: Record<string, string> = koreanMessages;
    expect(searchSettings("show hidden notices", (key) => en[key] ?? key).map((r) => r.section)).toContain("permissions-approval-dialog");
    expect(searchSettings("숨긴 알림", (key) => ko[key] ?? key).map((r) => r.section)).toContain("permissions-approval-dialog");
  });
});
