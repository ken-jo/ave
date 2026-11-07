import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { approvalRequest, deferred, submitChatMessage } from "../../../../test/renderer/helpers.js";
import { MOCK_DEFAULT_SESSION_ID } from "../../../../test/renderer/mock-ave-api.js";
import { formatStagedEnvelope, stagedOriginFor } from "../../../shared/staged-origins.js";
import { SUGGESTIONS_SESSION_ID } from "../../../shared/suggestions-session.js";
import { TEST_IDS, testIdSelector } from "../../../shared/test-ids.js";

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

  it.each([
    ["mcp-prompt-emitted", "mcp-prompt:docs"],
    ["plugin-prompt-emitted", "plugin-prompt:notes:summarize"],
  ] as const)("names the conversation, not the earlier message, for a live %s turn", async (origin, source) => {
    const previous = "RUNSB: New-Item ./scratch/a.txt";
    const { emitApproval, emitChatStream } = await renderApp({
      hasApiKey: true,
      sessions: [{ id: MOCK_DEFAULT_SESSION_ID, title: "Scratch cleanup", modifiedAt: "2026-01-01T00:00:00Z" }],
      history: { sessionId: MOCK_DEFAULT_SESSION_ID, messages: [
        { index: 0, role: "user", content: previous },
        { index: 1, role: "assistant", content: "Created ./scratch/a.txt" },
      ] },
    });
    await screen.findByText(previous);
    await act(async () => {
      emitChatStream({ type: "user_message", origin, messageId: "prompt-row",
        text: formatStagedEnvelope(stagedOriginFor(origin), "Remove the scratch folder", source) });
    });
    await act(async () => {
      emitApproval(approvalRequest({ id: "prompt-turn", sessionId: MOCK_DEFAULT_SESSION_ID, createdAt: Date.now() }));
    });
    const line = await screen.findByTestId("approval-conversation");
    expect(line).toHaveTextContent("Scratch cleanup");
    expect(line).not.toHaveTextContent("New-Item");
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

  /** The imported_trigger cards the transcript draws; each names its envelope's source. */
  const cardsNaming = (container: HTMLElement, source: string) =>
    (container.textContent ?? "").split(source).length - 1;

  it("names the conversation for an MCP App message turn while its card is up, and draws that card once", async () => {
    const previous = "RUNSB: New-Item ./scratch/a.txt";
    const { container, api, emitApproval, emitOverlayShow } = await renderApp({
      hasApiKey: true,
      sessions: [{ id: MOCK_DEFAULT_SESSION_ID, title: "Scratch cleanup", modifiedAt: "2026-01-01T00:00:00Z" }],
      history: { sessionId: MOCK_DEFAULT_SESSION_ID, messages: [
        { index: 0, role: "user", content: previous },
        { index: 1, role: "assistant", content: "Created ./scratch/a.txt" },
      ] },
    });
    await screen.findByText(previous);
    // The app's draft goes into the empty composer; the user sends it.
    await act(async () => emitOverlayShow({
      id: "app:invoices:wipe", source: { kind: "app", serverId: "invoices", eventId: "wipe" },
      title: "invoices", summary: "Remove the scratch folder", running: false, createdAt: new Date().toISOString(),
      composerDraft: true, pendingPrompt: '<app-message source="app:invoices">\nRemove the scratch folder\n</app-message>',
    }));
    const textarea = container.querySelector<HTMLTextAreaElement>(testIdSelector(TEST_IDS.composerTextarea))!;
    await waitFor(() => expect(textarea.value).toBe("Remove the scratch folder"));
    const turn = deferred<{ ok: true }>();
    const announce = api.chatSend.getMockImplementation()!;
    api.chatSend.mockImplementationOnce(async (...args: Parameters<typeof announce>) => {
      void announce(...args);
      return turn.promise;
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    expect(api.chatSend.mock.calls[0]![2]).toBe("app-emitted");
    await act(async () => {
      emitApproval(approvalRequest({ id: "app-turn", sessionId: MOCK_DEFAULT_SESSION_ID, createdAt: Date.now() }));
    });
    const line = await screen.findByTestId("approval-conversation");
    expect(line).toHaveTextContent("Scratch cleanup");
    expect(line).not.toHaveTextContent("New-Item");
    expect(cardsNaming(container, "app:invoices")).toBe(1);
    await act(async () => {
      turn.resolve({ ok: true });
      await turn.promise;
    });
    expect(cardsNaming(container, "app:invoices")).toBe(1);
  });

  it("leaves no card behind when the host refuses a confirmed plugin suggestion", async () => {
    const { container, api, emitOverlayShow } = await renderApp({ hasApiKey: true, currentSession: SUGGESTIONS_SESSION_ID });
    api.chatSend.mockImplementationOnce(async () => ({ ok: false, error: "missing-imported-trigger-envelope" }) as never);
    await act(async () => emitOverlayShow({
      id: "plugin:refusedsrc:e1", source: { kind: "plugin", pluginId: "refusedsrc", eventId: "e1" },
      title: "refusedsrc", summary: "tidy the inbox", running: false, createdAt: new Date().toISOString(),
      pendingPrompt: '<imported-from-proactive source="overlay:refusedsrc">\ntidy the inbox\n</imported-from-proactive>',
    }));
    const confirm = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[data-testid="overlay-card-primary-action"]');
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('[data-testid="overlay-card-primary-action"]')).toBeNull());
    expect(cardsNaming(container, "overlay:refusedsrc")).toBe(0);
  });
});
