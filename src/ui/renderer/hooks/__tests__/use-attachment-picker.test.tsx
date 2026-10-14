// @vitest-environment jsdom
/**
 * attachPastedText: another surface (a terminal block) hands text to the
 * composer as a pasted-text chip, through the same capped atomic commit the
 * file picker uses.
 */
import "../../../../../test/renderer/setup.js";
import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAttachmentPicker } from "../use-attachment-picker.js";
import { ATTACH_MAX_COUNT, type Attachment } from "../../types/attachments.js";

function setup(initial: Attachment[] = []) {
  const insertAtCursor = vi.fn();
  const focus = vi.fn();
  const composerRef = { current: { insertAtCursor, focus, textarea: () => null } };
  const counter = { current: 0 };
  const hook = renderHook(() => {
    const [attachments, setAttachments] = useState<Attachment[]>(initial);
    const [question, setQuestion] = useState("");
    const picker = useAttachmentPicker({ attachmentNCounter: counter, setAttachments, setQuestion, composerRef });
    return { attachments, question, picker };
  });
  return { hook, insertAtCursor, focus };
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
});
