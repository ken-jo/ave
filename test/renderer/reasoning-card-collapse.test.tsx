// Reasoning starts collapsed, remains toggleable while streaming and preserves expansion across stable rerenders.
import "./setup.js";
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ReasoningCard } from "../../src/ui/renderer/components/TranscriptRenderer.js";

function card(streaming: boolean, text = "thinking content here") {
  return (
    <ReasoningCard
      entry={{ kind: "reasoning", text, streaming }}
    />
  );
}

function embeddedCard(streaming: boolean, text = "embedded thinking content") {
  return (
    <ReasoningCard
      entry={{ kind: "reasoning", text, streaming }}
      embedded
    />
  );
}

describe("ReasoningCard", () => {
  it("stays collapsed WHILE streaming; the header is clickable and expands the body", () => {
    const { queryByText, getByRole } = render(card(true));

    expect(queryByText("생각 중...")).toBeInTheDocument();
    expect(queryByText("thinking content here")).not.toBeInTheDocument();
    expect(getByRole("button")).not.toBeDisabled();

    fireEvent.click(getByRole("button"));
    expect(queryByText("thinking content here")).toBeInTheDocument();
  });

  it("stays collapsed after the stream finishes; click reveals the cached thought and sticks", () => {
    const { rerender, queryByText, getByRole } = render(card(true));
    rerender(card(false));

    expect(queryByText("생각 완료")).toBeInTheDocument();
    expect(queryByText("thinking content here")).not.toBeInTheDocument();

    fireEvent.click(getByRole("button"));
    expect(queryByText("thinking content here")).toBeInTheDocument();

    // Prop identity changes must not reset expansion.
    rerender(card(false));
    expect(queryByText("thinking content here")).toBeInTheDocument();
  });

  it("starts collapsed when mounted already-complete (session history rehydrate)", () => {
    const { queryByText, getByRole } = render(card(false));
    expect(queryByText("생각 완료")).toBeInTheDocument();
    expect(queryByText("thinking content here")).not.toBeInTheDocument();
    expect(getByRole("button")).not.toBeDisabled();

    fireEvent.click(getByRole("button"));
    expect(queryByText("thinking content here")).toBeInTheDocument();
  });

  it("keeps embedded reasoning collapsed (streaming + done) with manual expansion", () => {
    const { rerender, queryByText, getByRole } = render(embeddedCard(true));
    expect(queryByText("embedded thinking content")).not.toBeInTheDocument();
    expect(getByRole("button")).not.toBeDisabled();

    rerender(embeddedCard(false));
    expect(queryByText("생각 완료")).toBeInTheDocument();
    expect(queryByText("embedded thinking content")).not.toBeInTheDocument();

    fireEvent.click(getByRole("button"));
    expect(queryByText("embedded thinking content")).toBeInTheDocument();
  });
});

describe("ReasoningCard duration", () => {
  it("titles a finished live thought with how long it took", () => {
    const { getByRole } = render(
      <ReasoningCard entry={{ kind: "reasoning", text: "t", streaming: false, durationMs: 12_500 }} />,
    );
    expect(getByRole("button").textContent).toContain("12.5초 동안 생각함");
  });

  it("keeps the plain completed title when no duration is known (loaded history) or it was sub-second", () => {
    const { getByRole, rerender } = render(card(false));
    expect(getByRole("button").textContent).toContain("생각 완료");
    rerender(<ReasoningCard entry={{ kind: "reasoning", text: "t", streaming: false, durationMs: 400 }} />);
    expect(getByRole("button").textContent).toContain("생각 완료");
  });
});
