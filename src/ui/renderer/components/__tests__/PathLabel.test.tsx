// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PathLabel } from "../PathLabel.js";

describe("PathLabel", () => {
  it("separates the folders from the file name so the folders shrink first", () => {
    render(<PathLabel path="/work/project/src/ui/renderer/components/FileEditDiff.tsx" />);
    const label = screen.getByTestId("path-label");
    expect(label.querySelector('[data-path-part="directory"]')).toHaveTextContent("/work/project/src/ui/renderer/components/");
    expect(label.querySelector('[data-path-part="name"]')).toHaveTextContent("FileEditDiff.tsx");
    expect(label).toHaveAttribute("title", "/work/project/src/ui/renderer/components/FileEditDiff.tsx");
    expect(label).toHaveTextContent("/work/project/src/ui/renderer/components/FileEditDiff.tsx");
  });

  it("splits a Windows path at its last backslash and shows a bare name without a folder part", () => {
    const { rerender } = render(<PathLabel path={"C:\\work\\src\\a.ts"} />);
    expect(screen.getByTestId("path-label").querySelector('[data-path-part="name"]')).toHaveTextContent("a.ts");
    rerender(<PathLabel path="notes.md" />);
    expect(screen.getByTestId("path-label").querySelector('[data-path-part="directory"]')).toBeNull();
    expect(screen.getByTestId("path-label")).toHaveTextContent("notes.md");
  });

  it("spells hidden characters in the path", () => {
    const rlo = String.fromCodePoint(0x202e);
    render(<PathLabel path={`/work/safe${rlo}gnp.exe`} />);
    expect(screen.getByTestId("path-label").textContent).toBe("/work/safe\u27e8U+202E\u27e9gnp.exe");
  });
});
