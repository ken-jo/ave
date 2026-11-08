// A chat tile's header draws the agent status slot from the window's working selector: the conversation glyph at rest, the
// loader while the tile's turn runs, and the glyph again once it ends.
import "./setup.js";
import { describe, it, expect } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { submitChatMessage } from "./helpers.js";

function required<T extends Element>(element: T | null, what: string): T {
  if (element === null) throw new Error(`missing ${what}`);
  return element;
}

describe("agent status slot — chat tile header", () => {
  it("shows the glyph at rest, the loader while a turn runs, and the glyph again when it ends", async () => {
    const { container, api, emitChatStream } = await renderApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    let finishSend: ((value: { ok: true }) => void) | undefined;
    api.chatSend.mockImplementationOnce(() => new Promise((resolve) => { finishSend = resolve; }));
    const slot = () => required(container.querySelector<HTMLElement>('[data-testid="pane-agent-status"]'), "status slot");
    await waitFor(() => slot());
    // In the header, ahead of the title, with no badge: the tile draws its own cards.
    expect(required(container.querySelector('[data-testid="pane-header"]'), "pane header").contains(slot())).toBe(true);
    expect(slot().getAttribute("data-agent-status")).toBe("idle");
    expect(slot().hasAttribute("data-agent-badge")).toBe(false);

    await submitChatMessage(container, "ask");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    await act(async () => {
      emitChatStream({ type: "text_delta", text: "Working on it" });
    });
    await waitFor(() => expect(slot().getAttribute("data-agent-status")).toBe("working"));
    const loader = required(slot().querySelector<HTMLElement>('[role="img"]'), "loader");
    expect(loader.getAttribute("aria-label")).toBe("작업 중");
    expect(required(loader.querySelector("svg"), "loader svg").getAttribute("class")).toContain("motion-reduce:animate-none");

    await act(async () => {
      emitChatStream({ type: "done" });
      finishSend?.({ ok: true });
    });
    await waitFor(() => expect(slot().getAttribute("data-agent-status")).toBe("idle"));
  });
});
