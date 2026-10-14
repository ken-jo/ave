// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { ChatTranscript, type ChatTranscriptProps } from "../ChatTranscript.js";
import { t } from "../../../../i18n/runtime.js";

function props(streaming: boolean): ChatTranscriptProps {
  return {
    scrollViewportRef: createRef<HTMLDivElement>(),
    readingColumnClass: "",
    loadedSkills: [],
    visibleEntries: [{ kind: "user", text: "hi" }],
    hasApiKey: true,
    hasAskQuestions: false,
    suggestedRepliesActive: false,
    transcriptEntries: <p>entries</p>,
    chatEndRef: createRef<HTMLDivElement>(),
    streaming,
  };
}

describe("ChatTranscript accessibility", () => {
  it("is a labelled ARIA log that is busy while a turn streams and announces completion once", () => {
    const { rerender } = render(<ChatTranscript {...props(false)} />);
    const log = screen.getByRole("log");
    expect(log).toHaveAttribute("aria-label", t("chatView.transcriptLabel"));
    expect(log).toHaveAttribute("aria-busy", "false");
    expect(screen.getByTestId("chat-transcript-status").textContent).toBe("");

    rerender(<ChatTranscript {...props(true)} />);
    expect(log).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("chat-transcript-status").textContent).toBe("");

    rerender(<ChatTranscript {...props(false)} />);
    expect(log).toHaveAttribute("aria-busy", "false");
    expect(screen.getByTestId("chat-transcript-status").textContent).toBe(t("chatView.responseComplete"));

    // A new turn clears the previous notice so the next completion is announced again.
    rerender(<ChatTranscript {...props(true)} />);
    expect(screen.getByTestId("chat-transcript-status").textContent).toBe("");
  });
});
