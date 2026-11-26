import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/index.js";
import { en } from "../../../../i18n/messages/en.js";
import { ko } from "../../../../i18n/messages/ko.js";
import { SessionIndexingSection } from "../SessionIndexingSection.js";

const previousLocale = getLocale();
afterEach(() => setLocale(previousLocale));

function TestSettings({ onSave }: { onSave: (enabled: boolean) => void }) {
  const [enabled, setEnabled] = useState(true);
  return <SessionIndexingSection enabled={enabled} onChange={async next => {
    onSave(next);
    setEnabled(next);
  }} />;
}

describe("session search indexing switch", () => {
  it("shows no switch or notice when the release policy omits the preference", () => {
    render(<SessionIndexingSection enabled={undefined} onChange={vi.fn()} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
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
