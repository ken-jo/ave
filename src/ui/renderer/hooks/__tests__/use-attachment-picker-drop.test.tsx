// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useAttachmentPicker } from "../use-attachment-picker.js";
import type { Attachment } from "../../types/attachments.js";

const NOTES = { path: "/ws/notes.txt", name: "notes.txt", ext: "txt", bytes: 5, isImage: false };

function install(api: { prepareFileDrop: unknown; redeemDrop: unknown }) {
  (window as unknown as Record<string, unknown>).aveDrop = { prepareFileDrop: api.prepareFileDrop };
  (window as unknown as Record<string, unknown>).ave = { attach: { redeemDrop: api.redeemDrop } };
}

function useHarness(onDropRejected: (count: number) => void) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [question, setQuestion] = useState("");
  const picker = useAttachmentPicker({
    attachmentNCounter: { current: 0 },
    setAttachments,
    setQuestion,
    composerRef: { current: null },
    onDropRejected,
  });
  return { ...picker, attachments, question };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).aveDrop;
  delete (window as unknown as Record<string, unknown>).ave;
});

describe("useAttachmentPicker — composer drop", () => {
  it("passes the File objects (never paths) to the preload, redeems the token, commits a marker", async () => {
    const prepareFileDrop = vi.fn(async () => ({ ok: true, token: "tok", rejected: [] }));
    const redeemDrop = vi.fn(async () => ({ ok: true, files: [NOTES] }));
    install({ prepareFileDrop, redeemDrop });
    const onDropRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onDropRejected));
    const files = [new File(["hello"], "notes.txt")];
    await act(async () => { await result.current.handleDropFiles(files); });
    expect(prepareFileDrop).toHaveBeenCalledWith(files);
    expect(redeemDrop).toHaveBeenCalledWith("tok");
    expect(result.current.attachments).toEqual([expect.objectContaining({ kind: "file", path: NOTES.path, n: 1 })]);
    expect(result.current.question).toBe("[File #1] ");
    expect(onDropRejected).not.toHaveBeenCalled();
  });

  it("reports refused items and attaches nothing when main refuses the token", async () => {
    const prepareFileDrop = vi.fn(async () => ({
      ok: true,
      token: "tok",
      rejected: [{ name: ".env", reason: "sensitive-path" }],
    }));
    const redeemDrop = vi.fn(async () => ({ ok: false, error: "drop-token-expired" }));
    install({ prepareFileDrop, redeemDrop });
    const onDropRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onDropRejected));
    await act(async () => {
      await result.current.handleDropFiles([new File(["a"], ".env"), new File(["b"], "notes.txt")]);
    });
    expect(onDropRejected).toHaveBeenNthCalledWith(1, 1);
    expect(onDropRejected).toHaveBeenNthCalledWith(2, 1);
    expect(result.current.attachments).toEqual([]);
    expect(result.current.question).toBe("");
  });

  it("does not redeem when registration attached nothing", async () => {
    const prepareFileDrop = vi.fn(async () => ({ ok: false, error: "nothing-attachable", rejected: [{ name: "dir", reason: "not-a-file" }] }));
    const redeemDrop = vi.fn();
    install({ prepareFileDrop, redeemDrop });
    const onDropRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onDropRejected));
    await act(async () => { await result.current.handleDropFiles([new File([""], "dir")]); });
    expect(redeemDrop).not.toHaveBeenCalled();
    expect(onDropRejected).toHaveBeenCalledWith(1);
  });
});
