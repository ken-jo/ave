// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RefreshCw } from "lucide-react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ToolbarStatusPill } from "../ToolbarStatusPill.js";

describe("ToolbarStatusPill", () => {
  afterEach(() => cleanup());

  it("keeps the progress cursor on a busy pill that is not actionable", () => {
    render(
      <TooltipProvider>
        <ToolbarStatusPill tone="muted" icon={RefreshCw} busy disabled label="42%" title="Downloading" ariaLabel="Downloading 42%" testId="busy-pill" />
      </TooltipProvider>,
    );

    const pill = screen.getByTestId("busy-pill");
    expect(pill).toHaveAttribute("aria-disabled", "true");
    expect(pill).toHaveClass("cursor-progress");
    expect(pill).not.toHaveClass("aria-disabled:cursor-not-allowed");
  });
});
