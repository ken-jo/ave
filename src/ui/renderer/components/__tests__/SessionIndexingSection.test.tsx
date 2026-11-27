import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSettingsPath } from "../../../../shared/settings-tabs.js";
import { setProcessPlatform } from "../../../../__tests__/support/process-platform.js";
import { getLocale, setLocale } from "../../../../i18n/index.js";
import { en } from "../../../../i18n/messages/en.js";
import { ko } from "../../../../i18n/messages/ko.js";
import { SessionIndexingSection } from "../SessionIndexingSection.js";

const previousLocale = getLocale();
const host = process.platform;
beforeEach(() => setProcessPlatform("win32"));
afterEach(() => {
  setLocale(previousLocale);
  setProcessPlatform(host);
});

function TestSettings({ onSave }: { onSave: (enabled: boolean) => void }) {
  const [enabled, setEnabled] = useState(true);
  return <SessionIndexingSection enabled={enabled} onChange={async next => {
    onSave(next);
    setEnabled(next);
  }} />;
}

describe("session search indexing switch", () => {
  it("renders the advertised Windows destination without a switch when the preference is unavailable", () => {
    const path = parseSettingsPath("chat/session-indexing");
    expect(path).toEqual({ tab: "chat", section: "session-indexing" });
    const { container } = render(<SessionIndexingSection enabled={undefined} onChange={vi.fn()} />);
    expect(container.querySelector(`[data-settings-section="${path?.section}"]`)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["darwin", "linux"] as const)("has no destination or section on %s", platform => {
    setProcessPlatform(platform);
    expect(parseSettingsPath("chat/session-indexing")).toBeNull();
    const { container } = render(<SessionIndexingSection enabled={undefined} onChange={vi.fn()} />);
    expect(container.querySelector("[data-settings-section]")).toBeNull();
  });

  it.each([["en", en], ["ko", ko]] as const)("shows one stable off notice and no dialog (%s)", async (locale, messages) => {
    setLocale(locale);
    const save = vi.fn();
    const view = render(<TestSettings onSave={save} />);
    const control = screen.getByRole("switch", { name: messages["sessionIndexing.switch"] });
    expect(control).toBeChecked();
    expect(control).toHaveAccessibleDescription(locale === "en" ? /without containment on this PC/i : /이 PC에서.*격리 없이/);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(control);
    await waitFor(() => expect(control).not.toBeChecked());
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(messages["sessionIndexing.disabled"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<TestSettings onSave={save} />);
    expect(screen.getByRole("status")).toBe(notice);
    expect(save).toHaveBeenCalledExactlyOnceWith(false);
    fireEvent.click(control);
    await waitFor(() => expect(control).toBeChecked());
    expect(screen.queryByRole("status")).toBeNull();
  });
});
