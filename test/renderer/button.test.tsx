// @vitest-environment jsdom
import "./setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../../src/components/ui/button.js";

describe("Button", () => {
  it("styles aria-disabled buttons while preserving pointer access for tooltips", () => {
    render(<Button aria-disabled="true">Toggle column</Button>);

    const button = screen.getByRole("button", { name: "Toggle column" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveClass("aria-disabled:opacity-50");
    // Busy callers may choose a progress cursor.
    expect(button).not.toHaveClass("aria-disabled:cursor-not-allowed");
    expect(button).not.toHaveClass("aria-disabled:pointer-events-none");
    expect(button).not.toHaveClass("pointer-events-none");
    expect(button).not.toBeDisabled();
  });
});
