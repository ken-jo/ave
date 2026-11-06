// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useComposerDraft } from "../use-composer-draft.js";

describe("composer text provenance", () => {
  it("stages an idle app draft as one text-and-source snapshot", () => {
    const { result } = renderHook(() => useComposerDraft());
    act(() => result.current.stageAppMessage("Review this", "app:fixture"));
    expect(result.current.draft).toEqual({ text: "Review this", appSource: "app:fixture" });
  });
  it("retains provenance through edits and mixed app/user text", () => {
    const { result } = renderHook(() => useComposerDraft());
    act(() => result.current.stageAppMessage("App text", "app:fixture"));
    act(() => result.current.setQuestion((text) => text + " and my instructions"));
    expect(result.current.draft).toEqual({ text: "App text and my instructions", appSource: "app:fixture" });
  });
  it("clears provenance atomically when text is cleared, before later user input", () => {
    const { result } = renderHook(() => useComposerDraft());
    act(() => result.current.stageAppMessage("App text", "app:fixture"));
    act(() => { result.current.setQuestion(""); result.current.setQuestion("My own text"); });
    expect(result.current.draft).toEqual({ text: "My own text" });
  });
  it("requires visible replacement confirmation for an existing user draft", () => {
    const { result } = renderHook(() => useComposerDraft());
    act(() => result.current.setQuestion("Keep my draft"));
    act(() => result.current.stageAppMessage("App text", "app:fixture"));
    expect(result.current.draft).toEqual({ text: "Keep my draft", pendingAppDrafts: [{ text: "App text", appSource: "app:fixture" }] });
    act(() => result.current.acceptPendingAppDraft());
    expect(result.current.draft).toEqual({ text: "App text", appSource: "app:fixture" });
  });
  it("restores the source with parked text and clears it on user replacement after clearing", () => {
    const { result } = renderHook(() => useComposerDraft());
    act(() => result.current.setDraft({ text: "Restored app", appSource: "app:fixture" }));
    expect(result.current.draft.appSource).toBe("app:fixture");
    act(() => result.current.setDraft({ text: "Restored user" }));
    expect(result.current.draft).toEqual({ text: "Restored user" });
  });
  it("dismisses a pending suggestion without attaching its source to the user's draft", () => {
    const { result } = renderHook(() => useComposerDraft());
    act(() => result.current.setQuestion("User draft"));
    act(() => result.current.stageAppMessage("App text", "app:fixture"));
    act(() => result.current.dismissPendingAppDraft());
    expect(result.current.draft).toEqual({ text: "User draft" });
  });

  it("replaces the pending suggestion with the latest while preserving consent after text is cleared", () => {
    const { result } = renderHook(() => useComposerDraft());
    act(() => result.current.setQuestion("User draft"));
    act(() => result.current.stageAppMessage("First app text", "app:first"));
    act(() => result.current.setQuestion(""));
    act(() => result.current.stageAppMessage("Second app text", "app:second"));
    expect(result.current.draft).toEqual({ text: "", pendingAppDrafts: [
      { text: "Second app text", appSource: "app:second" },
    ] });
    act(() => result.current.acceptPendingAppDraft());
    expect(result.current.draft).toEqual({ text: "Second app text", appSource: "app:second" });
  });

});
