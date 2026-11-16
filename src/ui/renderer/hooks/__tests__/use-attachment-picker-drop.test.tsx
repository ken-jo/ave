// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { useAttachmentPicker } from "../use-attachment-picker.js";
import { attachmentSlotsFull, attachmentSlotsUsed, type Attachment, type FileAttachment } from "../../types/attachments.js";
import type { AttachmentRejection } from "../../../../shared/attachment-rejection.js";

const NOTES = { path: "/ws/notes.txt", name: "notes.txt", ext: "txt", bytes: 5, isImage: false };

const PNG = { path: "/ws/shot.png", name: "shot.png", ext: "png", bytes: 9, isImage: true, mimeType: "image/png" };

function install(api: { prepareFileDrop?: unknown; redeemDrop?: unknown; openFile?: unknown; readImage?: unknown }) {
  (window as unknown as Record<string, unknown>).aveDrop = { prepareFileDrop: api.prepareFileDrop };
  (window as unknown as Record<string, unknown>).ave = {
    attach: { redeemDrop: api.redeemDrop, openFile: api.openFile, readImage: api.readImage },
  };
}

function useHarness(onAttachmentRejected: (rejections: readonly AttachmentRejection[]) => void, initial: Attachment[] = []) {
  const [attachments, setAttachments] = useState<Attachment[]>(initial);
  const [question, setQuestion] = useState("");
  const picker = useAttachmentPicker({
    attachmentNCounter: { current: 0 },
    setAttachments,
    setQuestion,
    composerRef: { current: null },
    onAttachmentRejected,
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
    const onRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onRejected));
    const files = [new File(["hello"], "notes.txt")];
    await act(async () => { await result.current.handleDropFiles(files); });
    expect(prepareFileDrop).toHaveBeenCalledWith(files);
    expect(redeemDrop).toHaveBeenCalledWith("tok");
    expect(result.current.attachments).toEqual([expect.objectContaining({ kind: "file", path: NOTES.path, n: 1 })]);
    expect(result.current.question).toBe("[File #1] ");
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("names each lost file with its reason, once, when main refuses the token", async () => {
    const prepareFileDrop = vi.fn(async () => ({
      ok: true,
      token: "tok",
      rejected: [{ name: ".env", reason: "sensitive-path" }],
    }));
    const redeemDrop = vi.fn(async () => ({ ok: false, error: "drop-token-expired" }));
    install({ prepareFileDrop, redeemDrop });
    const onRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onRejected));
    await act(async () => {
      await result.current.handleDropFiles([new File(["a"], ".env"), new File(["b"], "notes.txt")]);
    });
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith([
      { name: ".env", reason: "sensitive-path" },
      { name: "notes.txt", reason: "drop-expired" },
    ]);
    expect(result.current.attachments).toEqual([]);
    expect(result.current.question).toBe("");
  });

  it("does not redeem when registration attached nothing, and passes main's reason on", async () => {
    const prepareFileDrop = vi.fn(async () => ({ ok: false, error: "nothing-attachable", rejected: [{ name: "dir", reason: "not-a-file" }] }));
    const redeemDrop = vi.fn();
    install({ prepareFileDrop, redeemDrop });
    const onRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onRejected));
    await act(async () => { await result.current.handleDropFiles([new File([""], "dir")]); });
    expect(redeemDrop).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith([{ name: "dir", reason: "not-a-file" }]);
  });

  it("says an item with no file on disk cannot be attached", async () => {
    // The preload found no path for any item, so nothing was registered and main named nothing.
    const prepareFileDrop = vi.fn(async () => ({ ok: false, error: "nothing-attachable" }));
    install({ prepareFileDrop, redeemDrop: vi.fn() });
    const onRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onRejected));
    await act(async () => { await result.current.handleDropFiles([new File(["%PDF"], "report.pdf")]); });
    expect(onRejected).toHaveBeenCalledWith([{ name: "report.pdf", reason: "no-file-path" }]);
  });

  it("reports a dropped item the preload left out next to the ones that were attached", async () => {
    const prepareFileDrop = vi.fn(async () => ({ ok: true, token: "tok", rejected: [] }));
    const redeemDrop = vi.fn(async () => ({ ok: true, files: [NOTES] }));
    install({ prepareFileDrop, redeemDrop });
    const onRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onRejected));
    await act(async () => {
      await result.current.handleDropFiles([new File(["x"], "notes.txt"), new File(["y"], "web-image.png")]);
    });
    expect(result.current.attachments).toHaveLength(1);
    expect(onRejected).toHaveBeenCalledWith([{ name: "web-image.png", reason: "no-file-path" }]);
  });
});

describe("useAttachmentPicker — picker", () => {
  it("reports the files main's picker refused, with main's reason", async () => {
    install({
      openFile: vi.fn(async () => ({
        canceled: false,
        files: [NOTES],
        rejected: [{ name: "setup.exe", reason: "denied-extension" }],
      })),
    });
    const onRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onRejected));
    await act(async () => { await result.current.handleAttach(); });
    expect(result.current.attachments).toHaveLength(1);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith([{ name: "setup.exe", reason: "denied-extension" }]);
  });

  it("reports an image main could not read, and one that is too large", async () => {
    const readImage = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "image_too_large" })
      .mockResolvedValueOnce({ ok: false, error: "EACCES: permission denied" });
    install({
      openFile: vi.fn(async () => ({ canceled: false, files: [PNG, { ...PNG, path: "/ws/b.png", name: "b.png" }], rejected: [] })),
      readImage,
    });
    const onRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onRejected));
    await act(async () => { await result.current.handleAttach(); });
    expect(result.current.attachments).toEqual([]);
    expect(onRejected).toHaveBeenCalledWith([
      { name: "shot.png", reason: "image-too-large" },
      { name: "b.png", reason: "unreadable" },
    ]);
  });

  it("reports the files that did not fit under the attachment limit", async () => {
    const held: Attachment[] = [1, 2, 3, 4].map((n) => ({ id: `f${n}`, n, kind: "file", path: `/ws/${n}.txt`, name: `${n}.txt`, ext: "txt", bytes: 1 }));
    install({
      openFile: vi.fn(async () => ({
        canceled: false,
        files: [NOTES, { ...NOTES, path: "/ws/extra.txt", name: "extra.txt" }],
        rejected: [],
      })),
    });
    const onRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onRejected, held));
    await act(async () => { await result.current.handleAttach(); });
    expect(result.current.attachments).toHaveLength(5);
    expect(onRejected).toHaveBeenCalledWith([{ name: "extra.txt", reason: "too-many" }]);
  });
});

describe("attachment slots (F11)", () => {
  const file = (n: number): FileAttachment => ({ id: `f${n}`, n, kind: "file", path: `/ws/${n}.txt`, name: `${n}.txt`, ext: "txt", bytes: 1 });
  const resource = (n: number): Attachment => ({
    id: `r${n}`, n, kind: "resource", serverId: "docs", uri: `doc:${n}`, label: `doc-${n}`, text: "body", truncated: false,
  });
  const reference = (n: number): Attachment => ({ ...file(n), reference: true });
  const paste = (n: number): Attachment => ({ id: `p${n}`, n, kind: "paste", text: "a\nb", lines: 2, chars: 3 });

  it("gives every kind but an MCP resource one slot", () => {
    expect(attachmentSlotsUsed([file(1), reference(2), paste(3), resource(4), resource(5)])).toBe(3);
    expect(attachmentSlotsFull([file(1), file(2), file(3), resource(4), resource(5)])).toBe(false);
    expect(attachmentSlotsFull([file(1), file(2), file(3), reference(4), paste(5), resource(6)])).toBe(true);
  });

  it("lets the picker add two files beside two resources and three files", async () => {
    install({
      openFile: vi.fn(async () => ({
        canceled: false,
        files: [NOTES, { ...NOTES, path: "/ws/extra.txt", name: "extra.txt" }, { ...NOTES, path: "/ws/over.txt", name: "over.txt" }],
        rejected: [],
      })),
    });
    const onRejected = vi.fn();
    const { result } = renderHook(() => useHarness(onRejected, [resource(1), resource(2), file(3), file(4), file(5)]));
    await act(async () => { await result.current.handleAttach(); });
    expect(attachmentSlotsUsed(result.current.attachments)).toBe(5);
    expect(result.current.attachments).toHaveLength(7);
    expect(onRejected).toHaveBeenCalledWith([{ name: "over.txt", reason: "too-many" }]);
  });

  it("lets another surface attach text beside five resources, and refuses it when five slots are taken", () => {
    const withResources = renderHook(() => useHarness(vi.fn(), [1, 2, 3, 4, 5].map(resource)));
    let attached = false;
    act(() => { attached = withResources.result.current.attachPastedText("from a terminal block"); });
    expect(attached).toBe(true);
    const full = renderHook(() => useHarness(vi.fn(), [1, 2, 3, 4, 5].map(file)));
    act(() => { attached = full.result.current.attachPastedText("from a terminal block"); });
    expect(attached).toBe(false);
  });
});
