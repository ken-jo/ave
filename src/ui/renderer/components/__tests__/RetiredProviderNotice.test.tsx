// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeprecatedModelNotice, RetiredProviderNotice } from "../RetiredProviderNotice.js";
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

  it("names a model its vendor's listing dropped and says chat is off (the retired tier)", () => {
    const reason = "unlisted";
    const bodyKey = "app.retiredModelNoticeBodyUnlisted";
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

describe("DeprecatedModelNotice (the deprecated tier, design model-capability-catalog §6.1)", () => {
  it.each(["en", "ko"] as const)("says in %s that the model is going away and chat still works", (locale) => {
    setLocale(locale);
    try {
      const onChooseModel = vi.fn();
      render(<DeprecatedModelNotice model="o4-mini" onChooseModel={onChooseModel} />);
      const notice = screen.getByTestId("deprecated-model-notice");
      // Non-blocking: a status line, not an alert.
      expect(notice).toHaveAttribute("role", "status");
      expect(notice).toHaveAttribute("data-deprecated-model", "o4-mini");
      expect(notice).toHaveTextContent(t("app.deprecatedModelNoticeTitle", { model: "o4-mini" }));
      expect(notice).toHaveTextContent(t("app.deprecatedModelNoticeBody"));
      expect(notice.textContent).toMatch(locale === "en" ? /still works/ : /계속할 수 있지만/);
      expect(notice.textContent).not.toMatch(/app\.deprecated|stays off|꺼져 있습니다/);
      fireEvent.click(screen.getByTestId("deprecated-model-notice-action"));
      expect(onChooseModel).toHaveBeenCalledTimes(1);
    } finally {
      setLocale("ko");
    }
  });

  it("can be dismissed for the model it names, and tells again for another deprecated model", () => {
    const { rerender } = render(<DeprecatedModelNotice model="o4-mini" onChooseModel={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: t("app.deprecatedModelNoticeDismiss") }));
    expect(screen.queryByTestId("deprecated-model-notice")).toBeNull();
    rerender(<DeprecatedModelNotice model="o3-mini" onChooseModel={vi.fn()} />);
    expect(screen.getByTestId("deprecated-model-notice")).toHaveAttribute("data-deprecated-model", "o3-mini");
    rerender(<DeprecatedModelNotice model={null} onChooseModel={vi.fn()} />);
    expect(screen.queryByTestId("deprecated-model-notice")).toBeNull();
  });
});
