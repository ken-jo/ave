// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileChangeBadge } from "../FileChangeBadge.js";

it("preserves sibling count and operation spans for known and unknown counts", () => {
  const change = { added: 8, removed: 2, countsKnown: true, operation: "create" as const };
  const { container, rerender } = render(<FileChangeBadge change={change} operationTitle="생성" />);
  const counts = screen.getByTestId("chat-side-panel-file-change-counts");
  const operation = screen.getByTestId("chat-side-panel-file-change-operation");
  expect(Array.from(container.children)).toEqual([counts, operation]);
  expect(counts.tagName).toBe("SPAN");
  expect(counts.className).toBe("shrink-0 font-mono text-dense");
  expect(counts).toHaveTextContent("+8 −2");
  expect(counts.children[0]).toHaveClass("text-(--file-change-add-fg)");
  expect(counts.children[1]).toHaveClass("text-(--file-change-delete-fg)");
  expect(operation.tagName).toBe("SPAN");
  expect(operation).toHaveTextContent("A");
  expect(operation).toHaveAttribute("title", "생성");
  expect(operation.className).toBe("flex size-4 shrink-0 items-center justify-center rounded text-tiny font-semibold bg-(--file-change-add-bg) text-(--file-change-add-fg)");

  rerender(<FileChangeBadge change={{ ...change, countsKnown: false, operation: "delete" }} operationTitle="Delete" />);
  expect(counts).toHaveTextContent("+— −—");
  expect(operation).toHaveTextContent("D");
  expect(operation).toHaveAttribute("title", "Delete");
  expect(operation).toHaveClass("bg-(--file-change-delete-bg)", "text-(--file-change-delete-fg)");
  expect(Array.from(container.children)).toEqual([counts, operation]);
});
