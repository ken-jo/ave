// @vitest-environment jsdom
/** A failed column leads with the action that can work: reveal when locked out, retry for every other failure. */
import "../../../../../../test/renderer/setup.js";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FolderColumn } from "../FolderColumn.js";
import type { FolderColumnProps } from "../FolderColumn.js";

function failed(error: string) {
  const props: FolderColumnProps = {
    column: { dir: "/w/broken", status: "error", entries: [], truncated: false, hidden: 0, error } as FolderColumnProps["column"],
    index: 1,
    selectedPath: undefined,
    isCurrent: true,
    focusedPath: undefined,
    locked: new Set<string>(),
    onSelect: vi.fn(),
    onFocusRow: vi.fn(),
    onKey: vi.fn(),
    onRetry: vi.fn(),
    onReveal: vi.fn(),
    registerRow: vi.fn(),
  };
  render(<FolderColumn {...props} />);
}

describe("FolderColumn failure actions", () => {
  it("makes reveal primary and retry a link when locked out", () => {
    failed("permission-denied");
    expect(screen.getByTestId("folder-column-reveal").className).toContain("bg-primary");
    expect(screen.getByTestId("folder-column-retry").className).toContain("underline-offset-4");
  });

  it("keeps retry primary for any other failure", () => {
    failed("read-failed");
    expect(screen.getByTestId("folder-column-retry").className).toContain("bg-primary");
    expect(screen.getByTestId("folder-column-reveal").className).toContain("underline-offset-4");
  });
});
