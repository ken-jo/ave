import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { ATTACH_MAX_COUNT } from "../types/attachments.js";
import { TEST_IDS, testIdSelector } from "../../../shared/test-ids.js";

type AttachMock = {
  openFile: ReturnType<typeof vi.fn>;
  readImage: ReturnType<typeof vi.fn>;
  saveClipboardImage: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
};

function installAttachMock(fileCount: number): AttachMock {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `C:\\workspace\\attach-${i}.md`,
    name: `attach-${i}.md`,
    ext: "md",
    bytes: 100 + i,
    isImage: false,
  }));
  const attach: AttachMock = {
    openFile: vi.fn(async () => ({ canceled: false, rejected: [], files })),
    readImage: vi.fn(async () => ({ ok: false, error: "not image" })),
    saveClipboardImage: vi.fn(async () => ({ ok: false })),
    openExternal: vi.fn(async () => ({ ok: true })),
  };
  (window.ave as unknown as { attach: AttachMock }).attach = attach;
  return attach;
}

describe("ChatView attachment 5-cap (handleAttach)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables the attach button and shows the reason together when the limit is reached (F11)", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    installAttachMock(ATTACH_MAX_COUNT - 1);
    const attachButton = await waitFor(() => {
      const el = container.querySelector('[data-testid="iab-attach-button"]');
      expect(el).not.toBeNull();
      return el as HTMLButtonElement;
    });

    await act(async () => { fireEvent.click(attachButton); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="chip-count-badge"]')?.textContent).toBe(`${ATTACH_MAX_COUNT - 1}/${ATTACH_MAX_COUNT}`);
    });
    // One slot left: the button works and nothing claims the limit was reached.
    expect(attachButton.disabled).toBe(false);
    expect(container.querySelector('[data-testid="composer-limit-warning"]')).toBeNull();

    installAttachMock(1);
    await act(async () => { fireEvent.click(attachButton); });
    await waitFor(() => { expect(attachButton.disabled).toBe(true); });
    expect(container.querySelector('[data-testid="composer-limit-warning"]')?.textContent).toContain(String(ATTACH_MAX_COUNT));
  });

  it("commits only the first 5 attachments when a single openFile returns 6 (6th dropped)", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    installAttachMock(6);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="iab-attach-button"]')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="iab-attach-button"]')!);
    });

    // 5 accepted → 2+ attachments render the stacked collapsed chip whose badge reads "<count>/<max>" plus " full" at the cap.
    const badge = await waitFor(() => {
      const el = container.querySelector('[data-testid="chip-count-badge"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain(`${ATTACH_MAX_COUNT}/${ATTACH_MAX_COUNT}`);
    expect(badge.textContent).toContain("full");

    // Markers #1..#5 landed in the composer body; the dropped 6th did not.
    const textarea = container.querySelector(
      testIdSelector(TEST_IDS.composerTextarea),
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    for (let n = 1; n <= ATTACH_MAX_COUNT; n++) {
      expect(textarea.value).toContain(`[File #${n}]`);
    }
    expect(textarea.value).not.toContain(`[File #${ATTACH_MAX_COUNT + 1}]`);
  });

  it("commits all attachments unchanged when the count is at the cap (exactly 5)", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    installAttachMock(ATTACH_MAX_COUNT);

    await waitFor(() => {
      expect(container.querySelector('[data-testid="iab-attach-button"]')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="iab-attach-button"]')!);
    });

    const badge = await waitFor(() => {
      const el = container.querySelector('[data-testid="chip-count-badge"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(badge.textContent).toContain(`${ATTACH_MAX_COUNT}/${ATTACH_MAX_COUNT}`);
    expect(badge.textContent).toContain("full");

    const textarea = container.querySelector(
      testIdSelector(TEST_IDS.composerTextarea),
    ) as HTMLTextAreaElement;
    expect(textarea.value).toContain(`[File #${ATTACH_MAX_COUNT}]`);
    expect(textarea.value).not.toContain(`[File #${ATTACH_MAX_COUNT + 1}]`);
  });
});

describe("ChatView — the conversation is a drop target (F13)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).aveDrop;
  });

  it("attaches a file dropped on the transcript through the drop-token path", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    const prepareFileDrop = vi.fn(async (_files: readonly File[]) => ({ ok: true, token: "tok", rejected: [] }));
    (window as unknown as Record<string, unknown>).aveDrop = { prepareFileDrop, resolveDroppedPaths: () => [] };
    const redeemDrop = vi.fn(async () => ({
      ok: true,
      files: [{ path: "/work/report.pdf", name: "report.pdf", ext: "pdf", bytes: 8, isImage: false }],
    }));
    (window.ave as unknown as { attach: Record<string, unknown> }).attach = { redeemDrop };
    const transcript = await waitFor(() => {
      const el = container.querySelector('[data-testid="chat-transcript-stage"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    const file = new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" });

    let claimed = false;
    await act(async () => {
      claimed = !fireEvent.drop(transcript, { dataTransfer: { types: ["Files"], files: [file] } });
    });

    expect(claimed).toBe(true);
    const textarea = container.querySelector(testIdSelector(TEST_IDS.composerTextarea)) as HTMLTextAreaElement;
    await waitFor(() => { expect(textarea.value).toContain("[File #1]"); });
    expect(prepareFileDrop).toHaveBeenCalledTimes(1);
    expect(prepareFileDrop.mock.calls[0][0]).toEqual([file]);
    expect(redeemDrop).toHaveBeenCalledWith("tok");
    expect(container.querySelectorAll('[data-testid="attachment-chip"]')).toHaveLength(1);
  });
});
