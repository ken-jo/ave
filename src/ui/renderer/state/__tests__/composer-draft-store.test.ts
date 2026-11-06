import { beforeEach, describe, expect, it } from "vitest";
import { clearComposerDrafts, parkComposerDraft, takeComposerDraft } from "../composer-draft-store.js";

beforeEach(clearComposerDrafts);
describe("composer draft provenance", () => {
  it("restores text and app source together after a tile unmount", () => {
    parkComposerDraft("chat", "Review this item", "app:fixture");
    expect(takeComposerDraft("chat")).toEqual({ text: "Review this item", appSource: "app:fixture" });
    expect(takeComposerDraft("chat")).toEqual({ text: "" });
  });
  it("clears the source with an empty draft and isolates conversations", () => {
    parkComposerDraft("a", "App text", "app:fixture");
    parkComposerDraft("b", "User text");
    parkComposerDraft("a", "", "app:fixture");
    expect(takeComposerDraft("a")).toEqual({ text: "" });
    expect(takeComposerDraft("b")).toEqual({ text: "User text" });
  });
  it("parks a pending app suggestion even when the current composer is empty", () => {
    const pending = [{ text: "Suggested", appSource: "app:fixture" }];
    parkComposerDraft("chat", "", undefined, pending);
    expect(takeComposerDraft("chat")).toEqual({ text: "", pendingAppDrafts: pending });
  });

});
