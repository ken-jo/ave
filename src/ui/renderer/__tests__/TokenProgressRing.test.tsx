import "../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TokenProgressRing } from "../components/TokenProgressRing.js";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { t } from "../../../i18n/runtime.js";

function renderRing(used: number, budget: number) {
  return render(
    <TooltipProvider>
      <TokenProgressRing used={used} budget={budget} />
    </TooltipProvider>,
  );
}

describe("TokenProgressRing", () => {
  it("renders the ring element with correct aria-label", () => {
    renderRing(47123, 64000);
    // 47123/64000 = 73.6% → Math.round → 74%
    const ring = screen.getByTestId("token-progress-ring");
    expect(ring).toBeInTheDocument();
    expect(ring.getAttribute("aria-label")).toBe(
      t("tokenProgressRing.projectedInputAriaLabel", { pct: "74" }),
    );
  });

  it("does not show percent text inside the visual element", () => {
    renderRing(47123, 64000);
    // The ring is visual-only — no visible percent text
    expect(screen.queryByText("74%")).not.toBeInTheDocument();
  });

  it("does not divide by zero when budget is 0", () => {
    expect(() => renderRing(0, 0)).not.toThrow();
    const ring = screen.getByTestId("token-progress-ring");
    expect(ring.getAttribute("aria-label")).toBe(
      t("tokenProgressRing.projectedInputAriaLabel", { pct: "0" }),
    );
  });

  it("caps pct at 100 when used exceeds budget", () => {
    renderRing(99999, 64000);
    const ring = screen.getByTestId("token-progress-ring");
    expect(ring.getAttribute("aria-label")).toBe(
      t("tokenProgressRing.projectedInputAriaLabel", { pct: "100" }),
    );
  });
});

describe("TokenProgressRing output limit source", () => {
  it("names who set the output limit the estimate assumes", async () => {
    const { fireEvent } = await import("@testing-library/react");
    render(
      <TooltipProvider>
        <TokenProgressRing
          used={1_000}
          budget={64_000}
          costEstimate={{
            inputTokens: 1_000,
            outputTokens: 16_384,
            inputCost: 0.001,
            outputCost: 0.01,
            total: 0.011,
            pricingKnown: true,
            outputLimitSource: "model-catalog",
          }}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByTestId("token-progress-ring"));
    const row = await screen.findByTestId("token-progress-ring-output-limit-source");
    // Literal text, not the key: a missing catalog entry would render the key.
    expect(row.textContent).toBe("출력 한도:모델 최대치 (모델 카탈로그)");
  });
});
