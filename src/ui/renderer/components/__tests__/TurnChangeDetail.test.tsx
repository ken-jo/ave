// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TurnReviewFile } from "../../../../shared/turn-change-review.js";
import { TurnChangeDetail } from "../TurnChangeDetail.js";
import { setLocale } from "../../../../i18n/runtime.js";

beforeEach(() => { setLocale("en"); });

function file(overrides: Partial<TurnReviewFile> = {}): TurnReviewFile {
  return {
    path: "src/source.ts", bytes: 30, lineCount: 4, referenceable: true,
    added: 2, removed: 1, operation: "modify", countsKnown: true,
    hunks: [{ id: "hunk-1", oldText: "old third\n", newText: "new third\nnew fourth\n",
      oldStartLine: 3, newStartLine: 3, startLine: 3, endLine: 4 }],
    ...overrides,
  };
}

describe("TurnChangeDetail", () => {
  it("references the file without a range from its header", () => {
    const onFileReference = vi.fn();
    render(<TurnChangeDetail file={file()} turnId="turn-1" onFileReference={onFileReference} />);
    fireEvent.click(screen.getByRole("button", { name: /파일 참조.*src\/source.ts|Reference file src\/source.ts/ }));
    expect(onFileReference).toHaveBeenCalledWith("src/source.ts");
    expect(screen.getByText("source.ts")).toBeTruthy();
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.queryByText(/Reload review|리뷰 새로고침/)).toBeNull();
  });

  it("uses a native hunk button with both old and new line columns and the exact reference selector", () => {
    const onReference = vi.fn();
    const { container } = render(<TurnChangeDetail file={file()} turnId="turn-1" onReference={onReference} />);
    const button = screen.getByRole("button", { name: /hunk.*1.*src\/source.ts|src\/source.ts.*hunk.*1/ });
    expect(button.tagName).toBe("BUTTON");
    expect(button.textContent).toContain("@@ -3,1 +3,2 @@");
    expect(container.querySelector('[data-diff-kind="removed"] [data-line-column="old"]')?.textContent).toBe("3");
    expect(container.querySelector('[data-diff-kind="removed"] [data-line-column="new"]')?.textContent).toBe("");
    expect(container.querySelector('[data-diff-kind="added"] [data-line-column="new"]')?.textContent).toBe("3");
    fireEvent.click(button);
    expect(onReference).toHaveBeenCalledWith({ path: "src/source.ts", startLine: 3, endLine: 4,
      turnId: "turn-1", hunkId: "hunk-1" });
  });

  it("activates a focused hunk with Enter and Space without nesting interactive controls", async () => {
    const user = (userEvent as unknown as { setup(): { keyboard(keys: string): Promise<void> } }).setup();
    const onReference = vi.fn();
    const { container } = render(<TurnChangeDetail file={file()} turnId="turn-1" onReference={onReference} />);
    const hunk = screen.getByRole("button", { name: /Reference hunk 1/ });
    hunk.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onReference).toHaveBeenCalledTimes(2);
    expect(container.querySelector("button button")).toBeNull();
    expect(document.activeElement).toBe(hunk);
  });

  it("counts and numbers CRLF and CR hunk lines without trailing phantom rows", () => {
    const current = file();
    current.hunks[0] = { ...current.hunks[0]!, oldText: "old third\r\nold fourth\r", newText: "new third\rnew fourth\r\n" };
    const { container } = render(<TurnChangeDetail file={current} turnId="turn-1" onReference={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Reference hunk 1/ }).textContent).toContain("@@ -3,2 +3,2 @@");
    expect(container.querySelectorAll('[data-diff-kind="removed"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-diff-kind="added"]')).toHaveLength(2);
    expect([...container.querySelectorAll('[data-diff-kind="added"] [data-line-column="new"]')].map((line) => line.textContent)).toEqual(["3", "4"]);
  });

  it("keeps stale or deleted ranges read-only without a red warning and permits an ordinary file mention", () => {
    const onReference = vi.fn();
    const onFileReference = vi.fn();
    render(<TurnChangeDetail file={file({ referenceable: false, operation: "delete" })}
      turnId="turn-1" onReference={onReference} onFileReference={onFileReference} />);
    const hunk = screen.getByRole("button", { name: /hunk.*1.*src\/source.ts|src\/source.ts.*hunk.*1/ });
    expect(hunk.hasAttribute("disabled")).toBe(true);
    fireEvent.click(hunk);
    expect(onReference).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /파일 참조.*src\/source.ts|Reference file src\/source.ts/ }));
    expect(onFileReference).toHaveBeenCalledWith("src/source.ts");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("bounds large hunks and pages without changing the full selected range", () => {
    const onReference = vi.fn();
    const base = file().hunks[0]!;
    const many = file({ hunks: Array.from({ length: 7 }, (_, index) => ({ ...base,
      id: `hunk-${index}`, oldText: "old\n".repeat(150), newText: "new\n".repeat(150),
      startLine: index + 1, endLine: index + 150 })) });
    const { container } = render(<TurnChangeDetail file={many} turnId="turn-1" onReference={onReference} />);
    expect(container.querySelectorAll("[data-hunk-id]")).toHaveLength(5);
    expect(container.querySelectorAll('[data-hunk-id="hunk-0"] [data-diff-kind="added"]')).toHaveLength(100);
    fireEvent.click(container.querySelector('[data-hunk-id="hunk-0"]')!);
    expect(onReference.mock.calls[0][0].endLine).toBe(150);
    fireEvent.click(screen.getByRole("button", { name: /Next hunks|다음 hunk/ }));
    expect(container.querySelectorAll("[data-hunk-id]")).toHaveLength(2);
  });

  it("renders unavailable recorded counts as unknown and translates the reference controls", () => {
    setLocale("ko");
    const onFileReference = vi.fn();
    render(<TurnChangeDetail file={file({ countsKnown: false, added: 0, removed: 0 })} turnId="turn-1" onFileReference={onFileReference} onReference={vi.fn()} />);
    expect(screen.getByTestId("turn-change-detail-counts").textContent).toBe("+— −—");
    fireEvent.click(screen.getByRole("button", { name: "파일 참조" }));
    expect(onFileReference).toHaveBeenCalledWith("src/source.ts");
    expect(screen.getByText("최근 턴 변경")).toBeTruthy();
  });
});
