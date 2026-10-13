// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RetiredProviderNotice } from "../RetiredProviderNotice.js";
import { t } from "../../../../i18n/runtime.js";
import { setLocale } from "../../../../i18n/runtime.js";

afterEach(cleanup);

describe("RetiredProviderNotice", () => {
  it("says the provider's service ended and sends the user to choose another", () => {
    const onChooseProvider = vi.fn();
    render(<RetiredProviderNotice retiredProvider="copilot" onChooseProvider={onChooseProvider} />);

    const notice = screen.getByTestId("retired-provider-notice");
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveTextContent(t("app.retiredProviderNoticeTitle"));
    expect(notice).toHaveTextContent(t("app.retiredProviderNoticeBody"));
    expect(notice.textContent).not.toMatch(/app\.retiredProvider/);

    fireEvent.click(screen.getByTestId("retired-provider-notice-action"));
    expect(onChooseProvider).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["catalog-deprecated", "app.retiredModelNoticeBodyDeprecated"],
    ["unlisted", "app.retiredModelNoticeBodyUnlisted"],
  ] as const)("names a retired model and why it is retired (%s)", (reason, bodyKey) => {
    const onChooseProvider = vi.fn();
    render(<RetiredProviderNotice retiredProvider={{ vendor: "openai", model: "o4-mini", reason }} onChooseProvider={onChooseProvider} />);
    const notice = screen.getByTestId("retired-provider-notice");
    expect(notice).toHaveAttribute("data-retired-model", "o4-mini");
    expect(notice).toHaveAttribute("data-retired-reason", reason);
    expect(notice).not.toHaveAttribute("data-retired-provider");
    expect(notice).toHaveTextContent(t("app.retiredModelNoticeTitle", { model: "o4-mini" }));
    expect(notice).toHaveTextContent(t(bodyKey));
    expect(notice.textContent).toContain("o4-mini");
    expect(notice.textContent).not.toMatch(/app\.retired|\[object Object\]|GitHub/);
    expect(screen.getByTestId("retired-provider-notice-action")).toHaveTextContent(t("app.retiredModelNoticeAction"));
    fireEvent.click(screen.getByTestId("retired-provider-notice-action"));
    expect(onChooseProvider).toHaveBeenCalledTimes(1);
  });

  it("is not dismissible: it renders until the marker is gone, and not at all without one", () => {
    const { rerender } = render(<RetiredProviderNotice retiredProvider="copilot" onChooseProvider={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /dismiss|✕/i })).toBeNull();
    rerender(<RetiredProviderNotice retiredProvider={null} onChooseProvider={vi.fn()} />);
    expect(screen.queryByTestId("retired-provider-notice")).toBeNull();
  });

  it.each(["ko", "en"] as const)("does not claim credential deletion succeeded in %s", (locale) => {
    setLocale(locale);
    try {
      render(<RetiredProviderNotice retiredProvider="copilot" onChooseProvider={vi.fn()} />);
      const notice = screen.getByTestId("retired-provider-notice");
      expect(notice.textContent).not.toMatch(/key deleted|키를 삭제했습니다/);
      expect(notice.textContent).toMatch(/no longer used|사용되지 않습니다/);
    } finally {
      setLocale("ko");
    }
  });
});
