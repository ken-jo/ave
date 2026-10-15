// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachToComposer, registerComposerTarget, resetComposerTargetsForTest, type ComposerKind } from "../composer-targets.js";

afterEach(() => {
  resetComposerTargetsForTest();
  document.body.replaceChildren();
});

function composer(groupId: string, kind: ComposerKind, options: { available?: boolean; full?: boolean } = {}) {
  const dock = document.createElement("div");
  const input = document.createElement("textarea");
  dock.append(input);
  document.body.append(dock);
  const state = { available: options.available ?? true };
  const attach = vi.fn(() => !options.full);
  const unregister = registerComposerTarget({ groupId, kind, attach, available: () => state.available, element: () => dock });
  return { attach, state, unregister, use: () => input.dispatchEvent(new FocusEvent("focusin", { bubbles: true })) };
}

describe("attachToComposer", () => {
  it("sends a side-panel terminal's block to its group's last-used composer, else that group's conversation", () => {
    const conversation = composer("a", "conversation");
    const sideChat = composer("a", "side-chat");
    const other = composer("b", "conversation");

    expect(attachToComposer("block", { fromGroup: "a" })).toBe(true);
    expect(conversation.attach).toHaveBeenCalledWith("block");

    sideChat.use();
    other.use(); // another group's use does not move group a's choice
    attachToComposer("block 2", { fromGroup: "a" });
    expect(sideChat.attach).toHaveBeenCalledWith("block 2");

    // Behind another tab, the side chat cannot take it; the conversation does.
    sideChat.state.available = false;
    attachToComposer("block 3", { fromGroup: "a" });
    expect(conversation.attach).toHaveBeenLastCalledWith("block 3");
  });

  it("sends a main terminal's block to the window's last-used composer, else a conversation on screen", () => {
    const focusedPane = composer("terminal-pane", "conversation", { available: false });
    const beside = composer("chat-pane", "conversation");
    const sideChat = composer("chat-pane", "side-chat");

    attachToComposer("first", { focusedGroupId: "terminal-pane" });
    expect(focusedPane.attach).not.toHaveBeenCalled();
    expect(beside.attach).toHaveBeenCalledWith("first");

    sideChat.use();
    attachToComposer("second", { focusedGroupId: "terminal-pane" });
    expect(sideChat.attach).toHaveBeenCalledWith("second");

    sideChat.unregister();
    attachToComposer("third", { focusedGroupId: "terminal-pane" });
    expect(beside.attach).toHaveBeenLastCalledWith("third");
  });

  it("says when no composer could take it, and passes on a full one", () => {
    expect(attachToComposer("x", { focusedGroupId: "none" })).toBe("no-composer");
    composer("a", "conversation", { full: true });
    expect(attachToComposer("x", { fromGroup: "a" })).toBe(false);
  });
});
