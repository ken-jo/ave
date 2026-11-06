import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { requestNewChatDraft } from "../chat-draft-request.js";
import { TEST_IDS, testIdSelector } from "../../../shared/test-ids.js";

describe("App new-chat draft requests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens a new conversation with the prepared draft in its composer, unsent", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    await act(async () => {
      requestNewChatDraft("Migrate the Ave extension \"Meeting\" (meeting) to host protocol 5.");
    });

    await waitFor(() => {
      const textarea = container.querySelector(testIdSelector(TEST_IDS.composerTextarea)) as HTMLTextAreaElement | null;
      expect(textarea?.value).toBe("Migrate the Ave extension \"Meeting\" (meeting) to host protocol 5.");
    });
    expect(api.chatSend).not.toHaveBeenCalled();
  });

  it("leaves the conversation on screen and its unsent text alone when main refuses the new chat", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    const textarea = () => container.querySelector(testIdSelector(TEST_IDS.composerTextarea)) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea(), { target: { value: "my unsent question" } });
    });
    api.chatNew.mockResolvedValueOnce({ ok: false, error: "project-not-allowed" } as never);

    await act(async () => {
      requestNewChatDraft("Migrate the Ave extension.");
    });

    await waitFor(() => expect(api.chatNew).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(textarea().value).toBe("my unsent question");
  });
});
