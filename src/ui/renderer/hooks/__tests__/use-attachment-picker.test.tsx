// @vitest-environment jsdom
/** attachPastedText: another surface (a terminal block) hands text to the composer as a pasted-text chip, through the same
 * capped atomic commit the file picker uses. */
import "../../../../../test/renderer/setup.js";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { clipPastedText, useAttachmentPicker } from "../use-attachment-picker.js";
import { ATTACH_MAX_COUNT, PASTE_TEXT_MAX_CHARS, type Attachment } from "../../types/attachments.js";

function setup(initial: Attachment[] = [], strict = false) {
  const insertAtCursor = vi.fn();
  const onPastedTextClipped = vi.fn();
  const focus = vi.fn();
  const composerRef = { current: { insertAtCursor, insertFileReference: vi.fn(() => ({ inserted: false })), insertFileMention: vi.fn(() => ({ inserted: false })), focus, textarea: () => null } };
  const counter = { current: 0 };
  const hook = renderHook(() => {
    const [attachments, setAttachments] = useState<Attachment[]>(initial);
    const [question, setQuestion] = useState("");
    const picker = useAttachmentPicker({
      attachmentNCounter: counter,
      setAttachments,
      setQuestion,
      composerRef,
      onPastedTextClipped,
    });
    return { attachments, question, picker };
  }, { reactStrictMode: strict });
  return { hook, insertAtCursor, focus, onPastedTextClipped, counter };
}

describe("useAttachmentPicker.attachPastedText", () => {
  it("adds a paste chip and inserts its marker at the caret", () => {
    const { hook, insertAtCursor, focus } = setup();
    let accepted = false;
    act(() => {
      accepted = hook.result.current.picker.attachPastedText("line 1\nline 2");
    });
    expect(accepted).toBe(true);
    expect(hook.result.current.attachments).toEqual([
      expect.objectContaining({ kind: "paste", n: 1, text: "line 1\nline 2", lines: 2, chars: 13 }),
    ]);
    expect(insertAtCursor).toHaveBeenCalledWith("[Pasted text #1 +2 lines] ");
    expect(focus).toHaveBeenCalled();
  });

  it("refuses when the composer already holds the maximum number of attachments", () => {
    const full: Attachment[] = Array.from({ length: ATTACH_MAX_COUNT }, (_, i) => ({
      id: `p${i}`, n: i + 1, kind: "paste", text: "x", lines: 1, chars: 1,
    }));
    const { hook, insertAtCursor } = setup(full);
    let accepted = true;
    act(() => {
      accepted = hook.result.current.picker.attachPastedText("more");
    });
    expect(accepted).toBe(false);
    expect(hook.result.current.attachments).toHaveLength(ATTACH_MAX_COUNT);
    expect(insertAtCursor).not.toHaveBeenCalled();
  });

  it("clips a text past the paste cap to its start and end and tells the user", () => {
    const { hook, onPastedTextClipped } = setup();
    const text = `HEAD${"x".repeat(PASTE_TEXT_MAX_CHARS * 2)}TAIL`;
    act(() => {
      hook.result.current.picker.attachPastedText(text);
    });
    const [chip] = hook.result.current.attachments;
    if (chip?.kind !== "paste") throw new Error("expected a paste chip");
    expect(chip.text.length).toBeLessThanOrEqual(PASTE_TEXT_MAX_CHARS);
    expect(chip.text.startsWith("HEAD")).toBe(true);
    expect(chip.text.endsWith("TAIL")).toBe(true);
    expect(chip.text).toMatch(/\[… \d+ characters omitted …\]/u);
    expect(chip.chars).toBe(chip.text.length);
    expect(onPastedTextClipped).toHaveBeenCalledWith({ keptChars: chip.text.length, totalChars: text.length });
  });

  it("does not report a clip for text within the cap", () => {
    const { hook, onPastedTextClipped } = setup();
    act(() => {
      hook.result.current.picker.attachPastedText("short");
    });
    expect(onPastedTextClipped).not.toHaveBeenCalled();
    expect(clipPastedText("x".repeat(PASTE_TEXT_MAX_CHARS))).toEqual({
      text: "x".repeat(PASTE_TEXT_MAX_CHARS),
      clipped: false,
    });
  });

  it.each([false, true])("numbers and marks each of several attaches (StrictMode %s)", (strict) => {
    const { hook, counter, insertAtCursor } = setup([], strict);
    act(() => {
      hook.result.current.picker.attachPastedText("one");
    });
    act(() => {
      hook.result.current.picker.attachPastedText("two");
    });
    expect(hook.result.current.attachments.map((attachment) => attachment.n)).toEqual([1, 2]);
    expect(counter.current).toBe(2);
    expect(insertAtCursor.mock.calls).toEqual([["[Pasted text #1 +1 lines] "], ["[Pasted text #2 +1 lines] "]]);
  });
});

describe("useAttachmentPicker.handleAttach", () => {
  it("writes the marker for each of two consecutive picks", async () => {
    let call = 0;
    const openFile = vi.fn(async () => {
      call += 1;
      return {
        canceled: false,
        rejected: [],
        files: [{ path: `/w/f${call}.txt`, name: `f${call}.txt`, ext: "txt", bytes: 3, isImage: false }],
      };
    });
    (window as unknown as { ave: unknown }).ave = { attach: { openFile, readImage: vi.fn() } };
    const { hook, insertAtCursor } = setup();
    await act(async () => {
      await hook.result.current.picker.handleAttach();
    });
    await act(async () => {
      await hook.result.current.picker.handleAttach();
    });
    expect(hook.result.current.attachments.map((attachment) => attachment.n)).toEqual([1, 2]);
    expect(insertAtCursor).toHaveBeenCalledTimes(2);
  });
});
