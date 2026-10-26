import "../../../../test/renderer/setup.js";
import { it, expect, vi } from "vitest";
import { waitFor, fireEvent, screen } from "@testing-library/react";
import { t } from "../../../i18n/runtime.js";
import { renderApp } from "../../../../test/renderer/render-app.js";

it("places the turn review in the composer notice stack above the input and status row", async () => {
  const { container } = await renderApp({ hasApiKey: true, history: {
    sessionId: "settled-review-session",
    messages: [{ index: 0, role: "user", content: "Update the source." }, { index: 1, role: "assistant", content: "Done." }],
  } });
  await waitFor(() => {
    const review = container.querySelector('[data-testid="turn-change-review"]');
    const queue = container.querySelector('[data-testid="composer-queue-dock"]');
    const frame = container.querySelector('[data-testid="composer-frame"]');
    const status = container.querySelector('[data-testid="iab-status-row"]');
    expect(review).not.toBeNull();
    expect(queue?.contains(review)).toBe(true);
    expect(review!.compareDocumentPosition(frame!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(review!.compareDocumentPosition(status!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(review).toHaveClass("mb-2");
    expect(frame?.parentElement).not.toHaveClass("pt-9");
  });
});

it("routes review references to the live composer and respects its attachment limit", async () => {
  const { container, api } = await renderApp({ hasApiKey: true });
  api.chatGetTurnReview = vi.fn(async (sessionId: string) => ({ ok: true as const, review: {
    sessionId, turnId: "latest-turn", files: [{ path: "src/source.ts", bytes: 12, lineCount: 1, referenceable: true,
      hunks: [{ id: "only-hunk", oldText: "old", newText: "new", oldStartLine: 1, newStartLine: 1, startLine: 1, endLine: 1 }],
    }],
  } }));
  fireEvent.click(await screen.findByRole("button", { name: t("fileEditDiff.reviewTitle") }));
  const file = await screen.findByRole("button", { name: t("fileEditDiff.reviewReferenceFile", { path: "src/source.ts", end: 1 }) });
  fireEvent.click(file);
  expect(container.querySelector('[data-testid="attachment-chip"]')).toHaveTextContent("src/source.ts:1-1");
  for (let index = 0; index < 5; index++) fireEvent.click(file);
  const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"][data-composer-surface="main"]')!;
  expect(textarea.value.match(/\[File #\d+\]/g)).toHaveLength(5);
  expect(textarea.value).not.toContain("[File #6]");
  expect(container.querySelector('[data-testid="chip-count-badge"]')).toHaveTextContent("5/5");
});
