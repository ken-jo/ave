// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { ChatTranscript, type ChatTranscriptProps } from "../ChatTranscript.js";
import { t } from "../../../../i18n/runtime.js";
import { PermissionReviewStatusCard } from "../PermissionReviewStatusCard.js";

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
    // Not nested in the log: nested live regions announce inconsistently.
    expect(log.contains(screen.getByTestId("chat-transcript-status"))).toBe(false);

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

  it("keeps status cards from being a second live region inside the log", () => {
    const entry = { kind: "permission_review", toolUseId: "t1", status: "reviewing", source: "builtin" } as const;
    const card = <PermissionReviewStatusCard entry={entry as never} />;
    const { unmount } = render(<ChatTranscript {...props(false)} transcriptEntries={card} />);
    const inLog = screen.getByTestId("permission-review-status-card");
    expect(screen.getByRole("log").contains(inLog)).toBe(true);
    expect(inLog).not.toHaveAttribute("role");
    expect(inLog).not.toHaveAttribute("aria-live");
    unmount();

    // The side chat shares the card without a log: there it stays a live region.
    render(card);
    const standalone = screen.getByTestId("permission-review-status-card");
    expect(standalone).toHaveAttribute("role", "status");
    expect(standalone).toHaveAttribute("aria-live", "polite");
  });
});
