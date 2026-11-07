import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { approvalRequest, deferred, submitChatMessage } from "../../../../test/renderer/helpers.js";
import { MOCK_DEFAULT_SESSION_ID } from "../../../../test/renderer/mock-ave-api.js";

/** The in-pane card names the message whose turn raised the request, not the conversation's cached title or an earlier turn. */
describe("approval card conversation line", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function sendAndAsk(
    setup: Parameters<typeof renderApp>[0],
    message: string,
  ): Promise<HTMLElement> {
    const turn = deferred<{ ok: true }>();
    const { container, api, emitApproval } = await renderApp({ hasApiKey: true, ...setup });
    api.chatSend.mockImplementationOnce(async () => turn.promise);
    await submitChatMessage(container, message);
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await act(async () => {
      emitApproval(approvalRequest({ id: "remove-item", sessionId: MOCK_DEFAULT_SESSION_ID, toolName: "bash",
        toolCategory: "shell", args: { command: "Remove-Item -Recurse ./scratch" }, createdAt: Date.now() }));
    });
    return screen.findByTestId("approval-conversation");
  }

  it("names the second turn's message after an earlier turn ran without a card", async () => {
    const previous = "RUNSB: New-Item ./scratch/a.txt";
    const current = "RUNSB: Remove-Item -Recurse ./scratch";
    const line = await sendAndAsk({
      // After the first turn the list carries the title derived from it, which is what the card used to show.
      sessions: [{ id: MOCK_DEFAULT_SESSION_ID, title: previous, modifiedAt: "2026-01-01T00:00:00Z" }],
      history: { sessionId: MOCK_DEFAULT_SESSION_ID, messages: [
        { index: 0, role: "user", content: previous },
        { index: 1, role: "assistant", content: "Created ./scratch/a.txt" },
      ] },
    }, current);
    expect(line).toHaveTextContent(current);
    expect(line).not.toHaveTextContent("New-Item");
  });

  it("names the first turn's message rather than the conversation title", async () => {
    const current = "RUNSB: Remove-Item -Recurse ./scratch";
    const line = await sendAndAsk({
      sessions: [{ id: MOCK_DEFAULT_SESSION_ID, title: "Scratch cleanup", modifiedAt: "2026-01-01T00:00:00Z" }],
      history: { sessionId: MOCK_DEFAULT_SESSION_ID, messages: [] },
    }, current);
    expect(line).toHaveTextContent(current);
    expect(line).not.toHaveTextContent("Scratch cleanup");
  });

  it("names a resumed turn by its own message, not the restored Continue row", async () => {
    const current = "RUNSB: Remove-Item -Recurse ./scratch";
    const { emitApproval } = await renderApp({
      hasApiKey: true,
      sessions: [{ id: MOCK_DEFAULT_SESSION_ID, title: "Scratch cleanup", modifiedAt: "2026-01-01T00:00:00Z" }],
      history: { sessionId: MOCK_DEFAULT_SESSION_ID, messages: [
        { index: 0, role: "user", content: current },
        { index: 1, role: "assistant", content: "Removing", interrupted: true, interruptedBy: "host-exit" },
        { index: 2, role: "user", content: "Continue", resumesInterruptedTurn: true },
      ] },
    });
    await act(async () => {
      emitApproval(approvalRequest({ id: "resumed", sessionId: MOCK_DEFAULT_SESSION_ID }));
    });
    expect(await screen.findByTestId("approval-conversation")).toHaveTextContent(current);
  });

  it("names the conversation when the request did not come from this conversation's turn", async () => {
    const { emitApproval } = await renderApp({
      hasApiKey: true,
      sessions: [{ id: MOCK_DEFAULT_SESSION_ID, title: "Scratch cleanup", modifiedAt: "2026-01-01T00:00:00Z" }],
      history: { sessionId: MOCK_DEFAULT_SESSION_ID, messages: [] },
    });
    await act(async () => {
      emitApproval(approvalRequest({ id: "no-turn", sessionId: MOCK_DEFAULT_SESSION_ID }));
    });
    expect(await screen.findByTestId("approval-conversation")).toHaveTextContent("Scratch cleanup");
  });
});
