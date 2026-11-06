import "../../../../test/renderer/setup.js";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { TEST_IDS, testIdSelector } from "../../../shared/test-ids.js";
import { MAIN_CHAT_GROUP_ID } from "../../../contract/app-contract.js";
import { ChatGroupSessionRegistry } from "../components/chat-group-session-registry.js";
import { takeComposerDraft } from "../state/composer-draft-store.js";
import { t } from "../../../i18n/runtime.js";

function suggestion(text: string, serverId = "fixture") {
  return {
    id: `app:${serverId}:${text}`, source: { kind: "app", serverId, eventId: text },
    title: serverId, summary: text, running: false, createdAt: "2026-11-06T00:00:00Z", composerDraft: true,
    pendingPrompt: `<app-message source="app:${serverId}">\n${text}\n</app-message>`,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("conversation app draft suggestions", () => {
  it("keeps typing focus and politely offers keyboard-reachable replacement above the composer", async () => {
    const user = userEvent.setup();
    const { container, api, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const textarea = await waitFor(() => {
      const field = container.querySelector<HTMLTextAreaElement>(testIdSelector(TEST_IDS.composerTextarea));
      expect(field).not.toBeNull();
      return field!;
    });
    await user.click(textarea);
    await user.keyboard("My draft");
    await act(async () => emitOverlayShow(suggestion("Review this")));
    const banner = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-testid="app-draft-banner"]');
      expect(element).not.toBeNull();
      return element!;
    });
    expect(document.activeElement).toBe(textarea);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(within(banner).getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(banner.textContent).toContain("fixture");
    expect(banner.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.keyboard(" continues ");
    expect(textarea.value).toBe("My draft continues ");
    expect(document.activeElement).toBe(textarea);
    expect(api.chatSend).not.toHaveBeenCalled();
    expect(banner.isConnected).toBe(true);
    const dismiss = within(banner).getByRole("button", { name: t("app.dismissAppDraft") });
    // Natural tab order reaches both actions; the live announcement does not enter it.
    dismiss.focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(banner).getByRole("button", { name: t("app.replaceAppDraft") }));
    await user.keyboard("{Enter}");
    expect(textarea.value).toBe("Review this");
    expect(document.activeElement).toBe(textarea);
    expect(container.querySelector('[data-testid="app-draft-banner"]')).toBeNull();
  });

  it("shows only the latest suggestion without changing an existing user draft", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const textarea = await waitFor(() => {
      const field = container.querySelector<HTMLTextAreaElement>(testIdSelector(TEST_IDS.composerTextarea));
      expect(field).not.toBeNull();
      return field!;
    });
    fireEvent.change(textarea, { target: { value: "User draft" } });
    await act(async () => { emitOverlayShow(suggestion("Older")); emitOverlayShow(suggestion("Latest", "other")); });
    const banner = await waitFor(() => {
      const element = container.querySelector<HTMLElement>('[data-testid="app-draft-banner"]');
      expect(element?.textContent).toContain("Latest");
      return element!;
    });
    expect(container.querySelectorAll('[data-testid="app-draft-banner"]')).toHaveLength(1);
    expect(banner.textContent).not.toContain("Older");
    expect(textarea.value).toBe("User draft");
    fireEvent.click(within(banner).getByRole("button", { name: t("app.dismissAppDraft") }));
    expect(textarea.value).toBe("User draft");
    expect(container.querySelector('[data-testid="app-draft-banner"]')).toBeNull();
  });

  it("parks the previous conversation draft before opening a new app-authored draft", async () => {
    const published = vi.spyOn(ChatGroupSessionRegistry.prototype, "publish");
    const { container, api } = await renderApp({ hasApiKey: true,
      currentSession: "previous", history: { sessionId: "previous", messages: [{ index: 0, role: "user", content: "Earlier turn" }] },
    });
    await waitFor(() => expect(published.mock.calls.some(([group, handle]) => group === MAIN_CHAT_GROUP_ID && handle.currentSessionId === "previous")).toBe(true));
    const textarea = container.querySelector<HTMLTextAreaElement>(testIdSelector(TEST_IDS.composerTextarea))!;
    fireEvent.change(textarea, { target: { value: "Keep previous draft" } });
    api.chatGetHistory.mockResolvedValue({ sessionId: "next", messages: [] });
    const handle = published.mock.calls.filter(([group]) => group === MAIN_CHAT_GROUP_ID).at(-1)![1];
    await act(async () => { await handle.startNewChat(undefined, { draft: "New app draft", appSource: "app:fixture" }); });
    await waitFor(() => expect(textarea.value).toBe("New app draft"));
    expect(takeComposerDraft("previous")).toEqual({ text: "Keep previous draft" });
    expect(container.querySelector('[data-testid="app-draft-banner"]')).toBeNull();
  });
});
