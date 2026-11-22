// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAttachmentReclaim } from "../use-attachment-reclaim.js";
import type { Attachment } from "../../types/attachments.js";

const image: Attachment = {
  id: "clip-1", n: 1, kind: "image", path: "/tmp/ave-clipboard-x/ave-clip-AbC123/image.png",
  mimeType: "image/png", width: 1, height: 1, bytes: 8, dataUrl: "data:image/png;base64,AA==",
};
const file: Attachment = { id: "file-2", n: 2, kind: "file", path: "/work/report.pdf", name: "report.pdf", ext: "pdf", bytes: 9 };
const mention: Attachment = { id: "ref-3", n: 3, kind: "file", path: "/work/src/app.ts", name: "app.ts", ext: "ts", bytes: 0, reference: true };
const paste: Attachment = { id: "paste-4", n: 4, kind: "paste", text: "a\nb", lines: 2, chars: 3 };

let release: ReturnType<typeof vi.fn>;
beforeEach(() => {
  release = vi.fn(async () => ({ ok: true }));
  (window as unknown as Record<string, unknown>).ave = { attach: { release } };
});

function mount(initial: Attachment[]) {
  return renderHook(({ attachments }) => useAttachmentReclaim(attachments), { initialProps: { attachments: initial } });
}

describe("useAttachmentReclaim", () => {
  it("releases an attachment's path when its chip is removed, and only that one", () => {
    const hook = mount([image, file]);
    expect(release).not.toHaveBeenCalled();
    hook.rerender({ attachments: [file] });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith([image.path]);
  });

  it("releases nothing for a file mention or a pasted text: they hold no path in main", () => {
    const hook = mount([mention, paste]);
    hook.rerender({ attachments: [] });
    hook.unmount();
    expect(release).not.toHaveBeenCalled();
  });

  it("waits for a send to settle, then releases what the sent message carried", async () => {
    const hook = mount([image, file]);
    let accept!: () => void;
    const send = new Promise<void>((resolve) => { accept = resolve; });
    act(() => { void hook.result.current.holdDuring(send); });
    // The composer is emptied as the send starts.
    hook.rerender({ attachments: [] });
    expect(release).not.toHaveBeenCalled();
    await act(async () => { accept(); await send; });
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith([image.path, file.path]);
  });

  it("releases nothing when a refused send puts the draft back", async () => {
    const hook = mount([image]);
    let refuse!: (error: Error) => void;
    const send = new Promise<void>((_resolve, reject) => { refuse = reject; });
    act(() => { void hook.result.current.holdDuring(send).catch(() => {}); });
    hook.rerender({ attachments: [] });
    // The send puts the draft and its attachment back while it handles the refusal, before its promise settles.
    hook.rerender({ attachments: [image] });
    await act(async () => {
      refuse(new Error("refused"));
      await send.catch(() => {});
    });
    expect(release).not.toHaveBeenCalled();
    // Removed for real afterwards: released then.
    hook.rerender({ attachments: [] });
    expect(release).toHaveBeenCalledWith([image.path]);
  });

  it("releases what is still held when the composer's owner goes away", () => {
    const hook = mount([image, file]);
    hook.unmount();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith([image.path, file.path]);
  });
});
