import "../../../../../test/renderer/setup.js";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { loadLocaleMessages } from "../../../../i18n/messages/index.js";
import { SubscriptionPlanUsageView } from "../SubscriptionPlanUsageView.js";

const OBSERVED_AT = Date.UTC(2026, 10, 13, 3);
let priorLocale = getLocale();

beforeEach(() => {
  priorLocale = getLocale();
  setLocale("en");
  vi.useFakeTimers();
  vi.setSystemTime(OBSERVED_AT);
});

afterEach(() => {
  vi.useRealTimers();
  setLocale(priorLocale);
});

describe("subscription quota gauges", () => {
  it("renders nothing without a provider report", () => {
    const { container, rerender } = render(<SubscriptionPlanUsageView />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SubscriptionPlanUsageView usage={{ observedAt: OBSERVED_AT, windows: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("preserves a reported zero and identifies the observation time", () => {
    render(<SubscriptionPlanUsageView usage={{ observedAt: OBSERVED_AT,
      windows: [{ id: "codex:primary", usedPercent: 0, windowDurationMins: 300 }] }} />);
    expect(screen.getByText("0% used")).toBeVisible();
    expect(screen.getByText(/^Reported /)).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
    expect(screen.queryByText(/^Resets /)).toBeNull();
    expect(screen.queryByTestId("subscription-plan-usage:warning")).toBeNull();
  });

  it("shows reset-only reports without inventing a percentage or gauge", () => {
    render(<SubscriptionPlanUsageView usage={{ observedAt: OBSERVED_AT,
      windows: [{ id: "five_hour", resetsAt: OBSERVED_AT + 3_600_000 }] }} />);
    expect(screen.getByText("5-hour window")).toBeVisible();
    expect(screen.getByText(/^Resets /)).toBeVisible();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/% used/)).toBeNull();
  });

  it("labels a burn-rate warning as a local projection separately from usage", () => {
    render(<SubscriptionPlanUsageView usage={{ observedAt: OBSERVED_AT,
      windows: [{ id: "codex:primary", usedPercent: 60, resetsAt: OBSERVED_AT + 7_200_000,
        projectedLimitAt: OBSERVED_AT + 3_600_000 }] }} />);
    expect(screen.getByText("60% used")).toBeVisible();
    expect(screen.getByTestId("subscription-plan-usage:warning")).toHaveTextContent("projected to reach the limit");
    expect(screen.getByTestId("subscription-plan-usage:warning")).toHaveTextContent("This is an estimate.");
  });

  it("omits predictions that do not precede reset or have already elapsed", () => {
    render(<SubscriptionPlanUsageView usage={{ observedAt: OBSERVED_AT, windows: [
      { id: "late", usedPercent: 60, resetsAt: OBSERVED_AT + 3_600_000, projectedLimitAt: OBSERVED_AT + 7_200_000 },
      { id: "elapsed", usedPercent: 60, resetsAt: OBSERVED_AT + 3_600_000, projectedLimitAt: OBSERVED_AT - 1 },
    ] }} />);
    expect(screen.queryByTestId("subscription-plan-usage:warning")).toBeNull();
  });

  it("removes a report when its reset passes without a new provider sample", () => {
    render(<SubscriptionPlanUsageView usage={{ observedAt: OBSERVED_AT,
      windows: [{ id: "five_hour", usedPercent: 80, resetsAt: OBSERVED_AT + 1_000 }] }} />);
    expect(screen.getByText("80% used")).toBeVisible();
    act(() => vi.advanceTimersByTime(1_001));
    expect(screen.queryByTestId("subscription-plan-usage")).toBeNull();
  });

  it("expires a local prediction without changing the provider's reported gauge", () => {
    render(<SubscriptionPlanUsageView usage={{ observedAt: OBSERVED_AT, windows: [
      { id: "five_hour", usedPercent: 80, resetsAt: OBSERVED_AT + 2_000, projectedLimitAt: OBSERVED_AT + 1_000 },
    ] }} />);
    expect(screen.getByTestId("subscription-plan-usage:warning")).toBeVisible();
    act(() => vi.advanceTimersByTime(1_001));
    expect(screen.queryByTestId("subscription-plan-usage:warning")).toBeNull();
    expect(screen.getByText("80% used")).toBeVisible();
  });

  it("omits already reset windows and keeps a still active window", () => {
    render(<SubscriptionPlanUsageView usage={{ observedAt: OBSERVED_AT, windows: [
      { id: "five_hour", usedPercent: 80, resetsAt: OBSERVED_AT },
      { id: "seven_day", usedPercent: 20, resetsAt: OBSERVED_AT + 3_600_000 },
    ] }} />);
    expect(screen.queryByText("80% used")).toBeNull();
    expect(screen.getByText("20% used")).toBeVisible();
  });

  it("localizes the usage and estimate labels", async () => {
    await loadLocaleMessages("ko");
    setLocale("ko");
    render(<SubscriptionPlanUsageView usage={{ observedAt: OBSERVED_AT, windows: [
      { id: "five_hour", usedPercent: 40, resetsAt: OBSERVED_AT + 7_200_000, projectedLimitAt: OBSERVED_AT + 3_600_000 },
    ] }} />);
    expect(screen.getByText("요금제 사용량")).toBeVisible();
    expect(screen.getByText("40% 사용")).toBeVisible();
    expect(screen.getByTestId("subscription-plan-usage:warning")).toHaveTextContent("추정됩니다");
  });
});
