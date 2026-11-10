// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { applyChatTranscriptUnderlayClips, chatTranscriptUnderlaysFor, registerChatTranscriptUnderlay } from "../chat-transcript-underlays.js";

describe("chat transcript underlays", () => {
  it("keeps separate panel owners isolated and resolves portaled slots independently of chat ancestry", () => {
    const host = document.createElement("div");
    const otherHost = document.createElement("div");
    const stage = document.createElement("div");
    const otherStage = document.createElement("div");
    const slot = document.createElement("div");
    const otherSlot = document.createElement("div");
    host.append(slot);
    otherHost.append(otherSlot);
    const release = registerChatTranscriptUnderlay(host, stage);
    const releaseOther = registerChatTranscriptUnderlay(otherHost, otherStage);
    try {
      expect(chatTranscriptUnderlaysFor(slot)).toEqual(new Set([stage]));
      expect(chatTranscriptUnderlaysFor(otherSlot)).toEqual(new Set([otherStage]));
      applyChatTranscriptUnderlayClips(new Map([[stage, "inset(1px)"], [otherStage, "inset(2px)"]]));
      expect(stage.style.clipPath).toBe("inset(1px)");
      expect(otherStage.style.clipPath).toBe("inset(2px)");
      applyChatTranscriptUnderlayClips(new Map([[otherStage, "inset(2px)"]]));
      expect(stage.style.clipPath).toBe("");
      expect(otherStage.style.clipPath).toBe("inset(2px)");
    } finally { release(); releaseOther(); }
  });

  it("restores original paint on unregister and leaves accessibility and pointer attributes intact", () => {
    const host = document.createElement("div");
    const stage = document.createElement("div");
    stage.style.clipPath = "inset(3px)";
    stage.style.pointerEvents = "auto";
    const release = registerChatTranscriptUnderlay(host, stage);
    applyChatTranscriptUnderlayClips(new Map([[stage, "inset(4px)"]]));
    release();
    expect(stage.style.clipPath).toBe("inset(3px)");
    expect(stage.style.pointerEvents).toBe("auto");
    expect(stage).not.toHaveAttribute("aria-hidden");
    expect(stage).not.toHaveAttribute("inert");
    expect(chatTranscriptUnderlaysFor(host).size).toBe(0);
  });
});
