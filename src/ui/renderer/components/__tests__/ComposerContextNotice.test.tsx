// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ComposerContextNotice } from "../ComposerContextNotice.js";

describe("ComposerContextNotice", () => {
  it.each([0, 0.89, NaN, Infinity])("omits non-actionable usage %s", (percent) => {
    const { queryByRole } = render(<ComposerContextNotice percent={percent} autoCompactEnabled />);
    expect(queryByRole("status")).toBeNull();
  });

  it.each([0.9, 0.95, 1, 1.09])("announces usage %s as a warning while compaction is enabled", (percent) => {
    const { getByRole } = render(<ComposerContextNotice percent={percent} autoCompactEnabled />);
    const notice = getByRole("status");
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(notice).toHaveAttribute("data-severity", "warning");
    expect(notice).toHaveTextContent(`${Math.round(percent * 100)}%`);
    expect(notice).not.toHaveClass("text-destructive");
  });

  it("does not promise automatic compaction when it is disabled", () => {
    const { getByRole } = render(<ComposerContextNotice percent={1.09} autoCompactEnabled={false} />);
    const notice = getByRole("status");
    expect(notice).toHaveAttribute("data-severity", "error");
    expect(notice).not.toHaveTextContent("자동 압축");
  });
});
