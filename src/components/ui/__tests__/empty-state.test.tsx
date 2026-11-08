// @vitest-environment jsdom
/**
 * The one empty-state hierarchy: one line is quiet muted text; two lines are a medium title over a muted secondary line;
 * at most one primary button, every other action a link.
 */
import "../../../../test/renderer/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EmptyState } from "../empty-state.js";

describe("EmptyState", () => {
  it("renders one line as muted text with no title weight", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    const title = container.querySelector("[data-empty-state-title]");
    expect(title?.textContent).toBe("Nothing here");
    expect(title?.className).toContain("text-muted-foreground");
    expect(title?.className).toContain("text-dense");
    expect(title?.className).not.toContain("font-medium");
    expect(container.querySelector("[data-empty-state-description]")).toBeNull();
  });

  it("renders two lines as a medium body-sm title over a muted dense line, a small gap apart", () => {
    const { container } = render(<EmptyState title="No schedule" description="Add one to start" />);
    const title = container.querySelector("[data-empty-state-title]");
    const description = container.querySelector("[data-empty-state-description]");
    expect(title?.className).toContain("text-body-sm");
    expect(title?.className).toContain("font-medium");
    expect(title?.className).toContain("text-foreground");
    expect(description?.className).toContain("text-dense");
    expect(description?.className).toContain("text-muted-foreground");
    expect(title?.parentElement?.className).toContain("gap-0.5");
  });

  it("draws the one action as a primary button and the rest as links", () => {
    const add = vi.fn();
    const reveal = vi.fn();
    render(
      <EmptyState
        title="Empty"
        action={{ label: "Add", onClick: add, testId: "primary" }}
        links={[{ label: "Reveal", onClick: reveal, testId: "link" }]}
      />,
    );
    const primary = screen.getByTestId("primary");
    const link = screen.getByTestId("link");
    expect(primary.className).toContain("bg-primary");
    expect(link.className).toContain("underline-offset-4");
    expect(link.className).not.toContain("bg-primary");
    expect(screen.getAllByRole("button").filter((button) => button.className.includes("bg-primary"))).toHaveLength(1);
    fireEvent.click(primary);
    fireEvent.click(link);
    expect(add).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("lets a site that had no padding drop the default p-4 entirely", () => {
    const { container } = render(<EmptyState title="Empty" className="p-0 pt-6" />);
    const host = container.querySelector("[data-empty-state]");
    expect(host?.className).not.toContain("p-4");
    expect(host?.className).toContain("pt-6");
  });

  it("passes host attributes through and centres on request", () => {
    render(<EmptyState title="Empty" align="center" data-testid="host" role="status" />);
    const host = screen.getByTestId("host");
    expect(host.getAttribute("role")).toBe("status");
    expect(host.className).toContain("text-center");
  });
});
