// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Composer } from "../Composer.js";
import type { Attachment } from "../../types/attachments.js";

const HISTORY = ["first prompt", "second prompt"];

function Harness({ initialText = "", history = HISTORY }: { initialText?: string; history?: readonly string[] }) {
  const [text, setText] = useState(initialText);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  return (
    <Composer
      text={text}
      onTextChange={setText}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      allocateN={() => 1}
      saveClipboardImage={vi.fn(async () => ({ ok: false }))}
      onSend={vi.fn()}
      promptHistory={history}
    />
  );
}

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("Composer prompt-history recall", () => {
  it("ArrowUp on an empty composer recalls the newest prompt, then older ones; ArrowDown returns to the empty draft", () => {
    render(<Harness />);
    const ta = textarea();
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("second prompt");
    ta.setSelectionRange(0, 0);
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("first prompt");
    ta.setSelectionRange(ta.value.length, ta.value.length);
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(ta.value).toBe("second prompt");
    ta.setSelectionRange(ta.value.length, ta.value.length);
    fireEvent.keyDown(ta, { key: "ArrowDown" });
    expect(ta.value).toBe("");
  });

  it("does not replace a typed draft", () => {
    render(<Harness initialText="my draft" />);
    const ta = textarea();
    ta.setSelectionRange(0, 0);
    fireEvent.keyDown(ta, { key: "ArrowUp" });
    expect(ta.value).toBe("my draft");
  });

  it("ignores modified arrows", () => {
    render(<Harness />);
    const ta = textarea();
    fireEvent.keyDown(ta, { key: "ArrowUp", metaKey: true });
    fireEvent.keyDown(ta, { key: "ArrowUp", altKey: true });
    expect(ta.value).toBe("");
  });
});
