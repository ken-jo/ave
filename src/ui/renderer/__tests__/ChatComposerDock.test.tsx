import "../../../../test/renderer/setup.js";
import { it, expect } from "vitest";
import { waitFor, fireEvent, screen, within } from "@testing-library/react";
import { t } from "../../../i18n/runtime.js";
import { renderApp } from "../../../../test/renderer/render-app.js";

async function summaryApp() {
  return renderApp({ hasApiKey: true, workspaceRoots: [{ path: "/work/project", isDefault: true }],
    history: { sessionId: "settled-review-session", projectRoot: "/work/project",
      messages: [{ index: 0, role: "user", content: "Update the source." }, { index: 1, role: "assistant", content: "Done." }] },
    turnReview: (sessionId) => ({ ok: true, review: { sessionId, turnId: "latest-turn", files: Array.from({ length: 9 }, (_, i) => ({
      path: `src/source-${i}.ts`, added: 1, removed: 1, operation: "modify", countsKnown: true, bytes: 4, lineCount: 1,
      referenceable: true, hunks: [{ id: `hunk-${i}`, oldText: "old\n", newText: "new\n", oldStartLine: 1, newStartLine: 1, startLine: 1, endLine: 1 }],
    })) } }),
  });
}
it("places only the compact five-file summary above the composer and its status row", async () => {
  const { container } = await summaryApp();
  const summary = await screen.findByTestId("latest-turn-summary");
  const queue = container.querySelector('[data-testid="composer-queue-dock"]')!;
  const frame = container.querySelector('[data-testid="composer-frame"]')!;
  const status = container.querySelector('[data-testid="iab-status-row"]')!;
  expect(queue.contains(summary)).toBe(true);
  expect(summary.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(summary.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(summary).getAllByTestId("latest-turn-summary-file")).toHaveLength(5);
  expect(within(summary).queryByRole("alert")).toBeNull();
  expect(summary.querySelector("[data-diff-kind]")).toBeNull();
  expect(screen.queryByTestId("turn-change-review")).toBeNull();
});
it("Show more reveals the first latest file in the existing Files tab with the Changed filter", async () => {
  await summaryApp();
  fireEvent.click(await screen.findByRole("button", { name: t("fileEditDiff.summaryShowMore") }));
  await screen.findByTestId("chat-side-panel-file-browser");
  await waitFor(() => expect(screen.getByRole("button", { name: /^변경|^Changed/ })).toHaveAttribute("aria-pressed", "true"));
  await waitFor(() => expect(screen.getByRole("treeitem", { name: /source-0.ts/ })).toHaveAttribute("aria-selected", "true"));
  expect(screen.getByTestId("turn-change-detail")).toBeVisible();
  expect(screen.getByTestId("latest-turn-summary")).not.toContainElement(screen.getByTestId("turn-change-detail"));
});
it("summary row reveal selects that file and its detail hunk references the active composer", async () => {
  const { container } = await summaryApp();
  const rows = await screen.findAllByTestId("latest-turn-summary-file");
  fireEvent.click(rows[2]!);
  await screen.findByTestId("turn-change-detail");
  await waitFor(() => expect(screen.getByRole("treeitem", { name: /source-2.ts/ })).toHaveAttribute("aria-selected", "true"));
  fireEvent.click(within(screen.getByTestId("turn-change-detail")).getByRole("button", { name: /Reference hunk|변경 부분 1 참조/ }));
  const composer = container.querySelector('[data-testid="composer-textarea"][data-composer-surface="main"]') as HTMLTextAreaElement;
  expect(composer.value).toContain("[File #1]");
  expect(screen.getByText("@src/source-2.ts:1-1")).toBeVisible();
});

it("reveals Files visibly over a narrow chat tile instead of hiding the requested panel", async () => {
  const { vi } = await import("vitest");
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentBoxSize: [{ inlineSize: 600, blockSize: 700 }], contentRect: { width: 600, height: 700 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver); }
    unobserve() {}
    disconnect() {}
  });
  try {
    await summaryApp();
    fireEvent.click(await screen.findByRole("button", { name: t("fileEditDiff.summaryShowMore") }));
    await waitFor(() => {
      const panel = screen.getByTestId("chat-side-panel-motion");
      expect(panel).toHaveAttribute("data-panel-mode", "overlay");
      expect(panel).toHaveAttribute("aria-hidden", "false");
    });
  } finally { vi.unstubAllGlobals(); }
});
