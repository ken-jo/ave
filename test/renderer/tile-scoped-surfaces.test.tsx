// Session-owned surfaces stay with their tiles; unowned surfaces render once for the window.
import "./setup.js";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import {
  approvalRequest,
  clickSidebarNavRow,
  collectTiles,
  focusTile,
  forceOverflowingSummaries,
  splitIntoThreeTiles,
  splitIntoNTiles,
  splitIntoTwoTiles,
  submitChatMessage,
  deferred,
  mountedTileIds,
  toggleTileMaximized,
} from "./helpers.js";
import { MOCK_DEFAULT_SESSION_ID, MOCK_SIDE_CHAT_SESSION_ID, type MockAveApi } from "./mock-ave-api.js";
import { MAIN_CHAT_GROUP_ID, MAX_CHAT_GROUPS } from "../../src/contract/app-contract.js";
import { BLOCKING_SURFACE_SELECTOR, TEST_IDS, chatSidePanelLauncherTestId, testIdSelector } from "../../src/shared/test-ids.js";
import type { MarketplaceAnnouncement } from "../../src/shared/marketplace-announcements.js";
import { CHAT_SESSION_DRAG_TYPE } from "../../src/ui/renderer/components/pane-drop.js";
import type { AveApi } from "../../src/ui/renderer/types.js";
import { A2ATaskState } from "../../src/shared/a2a.js";
import { SUGGESTIONS_SESSION_ID } from "../../src/shared/suggestions-session.js";

// Advance frames after committed layout when proving surface ownership and focus.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});

afterEach(() => {
  try {
    cleanup();
  } finally {
    vi.useRealTimers();
  }
});

async function advanceAnimationFrame(): Promise<void> {
  await act(async () => { vi.advanceTimersToNextFrame(); });
}

function permissionSubscription(api: MockAveApi, name: string): ReturnType<typeof vi.fn> {
  return (api.permission as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]!;
}

describe("permission disclosure toasts with two tiles", () => {
  it("subscribes and renders once for the window, not once per tile", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    const onHit = permissionSubscription(api, "onUserApprovalHit");
    await waitFor(() => expect(onHit).toHaveBeenCalled());

    await splitIntoTwoTiles(container);

    // Window-owned settings need one subscription regardless of conversation count.
    expect(onHit).toHaveBeenCalledTimes(1);

    const fire = onHit.mock.calls[0]?.[0] as (payload: {
      toolName: string;
      scope: "session" | "persistent";
      verdictAtApproval: "low" | "medium" | "high";
    }) => void;
    await act(async () => {
      fire({ toolName: "fs_write", scope: "persistent", verdictAtApproval: "low" });
    });

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="user-approval-hit-toast"]'),
      ).toHaveLength(1);
    });
  });

  it("subscribes the reviewer suggestion once however many conversations are open", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    const onSuggestion = permissionSubscription(api, "onReviewSuggestion");
    await waitFor(() => expect(onSuggestion).toHaveBeenCalled());

    await splitIntoTwoTiles(container);
    expect(onSuggestion).toHaveBeenCalledTimes(1);

    const fire = onSuggestion.mock.calls[0]?.[0] as (payload: {
      reason: "allow-always" | "repeat-allow";
      allowCount: number;
      allowAlwaysCount: number;
      threshold: number;
      windowMs: number;
    }) => void;
    await act(async () => {
      fire({
        reason: "repeat-allow",
        allowCount: 3,
        allowAlwaysCount: 0,
        threshold: 3,
        windowMs: 300000,
      });
    });

    // Window-owned approval suggestions render once and only when an approval surface exists.
    expect(
      container.querySelectorAll('[data-testid="reviewer-suggestion-band"]'),
    ).toHaveLength(0);
  });
});

describe("overlay cards with two tiles", () => {
  const overlayRegions = (tile: { element: HTMLElement }) =>
    tile.element.querySelectorAll('[data-testid="overlay-card-region"]');
  const windowRegion = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-overlay-surface="window"]');

  it("shows an app card in the tile holding the conversation it came from", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    // Origin ownership outranks focus when placing conversation cards.
    await focusTile(primary!);

    await act(async () => {
      emitOverlayShow({
        id: "app:invoices:e1",
        source: { kind: "app", serverId: "invoices", eventId: "e1" },
        originSessionId: `session-${second!.chatGroupId}`,
        title: "invoices",
        summary: "open the invoice",
        running: false,
        pendingPrompt: '<app-message source="app:invoices">\nopen the invoice\n</app-message>',
        createdAt: new Date().toISOString(),
      });
    });

    await waitFor(() => expect(overlayRegions(second!)).toHaveLength(1));
    expect(overlayRegions(primary!)).toHaveLength(0);
  });

  it("confirming an app card starts the turn in the tile that showed it", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await focusTile(primary!);

    await act(async () => {
      emitOverlayShow({
        id: "app:invoices:e2",
        source: { kind: "app", serverId: "invoices", eventId: "e2" },
        originSessionId: `session-${second!.chatGroupId}`,
        title: "invoices",
        summary: "settle the invoice",
        running: false,
        pendingPrompt: '<app-message source="app:invoices">\nsettle the invoice\n</app-message>',
        createdAt: new Date().toISOString(),
      });
    });

    const confirm = await waitFor(() => {
      const button = second!.element.querySelector<HTMLButtonElement>(
        '[data-testid="overlay-card-primary-action"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(confirm);
    });

    // Stage prompts in the origin conversation, not the focused one.
    await waitFor(() => {
      expect(second!.element.textContent).toContain("settle the invoice");
    });
    expect(primary!.element.textContent).not.toContain("settle the invoice");
  });

  it("runs an owned card's action in the conversation it came from, even after focus moves away", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await focusTile(second!);
    await act(async () => {
      emitOverlayShow({
        id: "app:invoices:e9",
        source: { kind: "app", serverId: "invoices", eventId: "e9" },
        originSessionId: `session-${second!.chatGroupId}`,
        title: "invoices",
        summary: "archive the invoice",
        running: false,
        pendingPrompt: '<app-message source="app:invoices">\narchive the invoice\n</app-message>',
        createdAt: new Date().toISOString(),
      });
    });
    const confirm = await waitFor(() => {
      const button = second!.element.querySelector<HTMLButtonElement>(
        '[data-testid="overlay-card-primary-action"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });

    // Resolve the card's origin at click time so focus changes cannot retarget staged prompts.
    await focusTile(primary!);
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => {
      expect(second!.element.textContent).toContain("archive the invoice");
    });
    expect(primary!.element.textContent).not.toContain("archive the invoice");
  });

  it("draws a routine card once, in the tile holding the Suggestions conversation, whatever has focus", async () => {
    const { container, emitRoutineFired } = await renderApp({ hasApiKey: true, currentSession: SUGGESTIONS_SESSION_ID });
    const [primary, second] = await splitIntoTwoTiles(container);
    // Routine results belong to Suggestions even while the user works in another tile.
    await act(async () => {
      emitRoutineFired({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt: new Date().toISOString(),
        title: "Daily schedule",
        summary: "daily summary",
      });
    });

    await waitFor(() => expect(overlayRegions(primary!)).toHaveLength(1));
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
    expect(overlayRegions(second!)).toHaveLength(0);
    expect(windowRegion(container)).toBeNull();

    await focusTile(primary!);
    await focusTile(second!);
    expect(overlayRegions(primary!)).toHaveLength(1);
    expect(overlayRegions(second!)).toHaveLength(0);
    expect(windowRegion(container)).toBeNull();
  });

  it("replaces the spinner with the result in the Suggestions tile, still one card", async () => {
    const { container, emitRoutineRunningStarted, emitRoutineFired } =
      await renderApp({ hasApiKey: true, currentSession: SUGGESTIONS_SESSION_ID });
    const [primary, second] = await splitIntoTwoTiles(container);
    const firedAt = new Date().toISOString();

    await act(async () => {
      emitRoutineRunningStarted({ routineId: "schedule-daily", firedAt, title: "Daily schedule" });
    });
    await waitFor(() => expect(overlayRegions(primary!)).toHaveLength(1));

    await focusTile(second!);
    await act(async () => {
      emitRoutineFired({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt,
        title: "Daily schedule",
        summary: "daily summary",
      });
    });

    await waitFor(() => expect(primary!.element.textContent).toContain("daily summary"));
    expect(overlayRegions(primary!)).toHaveLength(1);
    expect(overlayRegions(second!)).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
  });

  it("starts the confirmed turn in the Suggestions conversation, never in the focused one", async () => {
    const { container, api, emitOverlayShow } = await renderApp({ hasApiKey: true, currentSession: SUGGESTIONS_SESSION_ID });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitOverlayShow({
        id: "plugin:notes:focused",
        source: { kind: "plugin", pluginId: "notes", eventId: "focused" },
        title: "notes",
        summary: "suggested target",
        running: false,
        pendingPrompt: "<untrusted-plugin>notes</untrusted-plugin>",
        createdAt: new Date().toISOString(),
      });
    });
    const confirm = await waitFor(() => {
      const button = primary!.element.querySelector<HTMLButtonElement>(
        '[data-testid="overlay-card-primary-action"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });
    expect(second!.element.querySelector('[data-testid="overlay-card-primary-action"]')).toBeNull();

    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(primary!.element.textContent).toContain("suggested target"));
    expect(second!.element.textContent).not.toContain("suggested target");
    expect(api.chatSend).toHaveBeenCalled();
  });

  it("continues a suggestion in a new conversation when the user picks that instead", async () => {
    const { container, api, emitOverlayShow } = await renderApp({ hasApiKey: true, currentSession: SUGGESTIONS_SESSION_ID });
    const [primary] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitOverlayShow({
        id: "plugin:notes:fresh",
        source: { kind: "plugin", pluginId: "notes", eventId: "fresh" },
        title: "notes",
        summary: "fresh target",
        running: false,
        pendingPrompt: "<untrusted-plugin>notes</untrusted-plugin>",
        createdAt: new Date().toISOString(),
      });
    });
    const secondary = await waitFor(() => {
      const button = primary!.element.querySelector<HTMLButtonElement>(
        '[data-testid="overlay-card-secondary-action"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });
    expect(secondary.textContent).toBe("새 대화에서 이어가기");

    await act(async () => {
      fireEvent.click(secondary);
    });

    // Start a fresh conversation and preserve plugin provenance on its first staged prompt.
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    expect(api.chatNew.mock.invocationCallOrder[0]!).toBeLessThan(api.chatSend.mock.invocationCallOrder[0]!);
    expect(api.chatSend.mock.calls[0]![2]).toBe("plugin-emitted");
    await waitFor(() => expect(primary!.element.textContent).toContain("fresh target"));
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(0);
  });

  it("holds a suggestion while its conversation is not open, drawing it over no other conversation", async () => {
    const { container, api, emitOverlayShow } = await renderApp({ hasApiKey: true });
    await splitIntoTwoTiles(container);

    await act(async () => {
      emitOverlayShow({
        id: "plugin:notes:held",
        source: { kind: "plugin", pluginId: "notes", eventId: "held" },
        title: "notes",
        summary: "held suggestion",
        running: false,
        pendingPrompt: "<untrusted-plugin>notes</untrusted-plugin>",
        createdAt: new Date().toISOString(),
      });
    });

    await waitFor(() => expect(api.chatSessions.mock.calls.length).toBeGreaterThan(1));
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(0);
    expect(container.textContent).not.toContain("held suggestion");
  });

  it("dismisses a routine card once, acknowledging it a single time", async () => {
    const { container, api, emitRoutineFired } = await renderApp({ hasApiKey: true, currentSession: SUGGESTIONS_SESSION_ID });
    await splitIntoTwoTiles(container);
    const firedAt = new Date().toISOString();

    await act(async () => {
      emitRoutineFired({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt,
        title: "Daily schedule",
        summary: "daily summary",
      });
    });

    const dismiss = await waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="routine-card-dismiss"]',
      );
      expect(button).toBeDefined();
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(dismiss);
    });

    await waitFor(() => {
      expect(api.acknowledgeRoutineResult).toHaveBeenCalledTimes(1);
    });
    expect(api.acknowledgeRoutineResult).toHaveBeenCalledWith("schedule-daily", firedAt);
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(0);
  });
});

describe("overlay cards whose origin conversation leaves the screen", () => {
  const appCard = (id: string, originSessionId: string, summary: string) => ({
    id,
    source: { kind: "app", serverId: "invoices", eventId: id },
    originSessionId,
    title: "invoices",
    summary,
    running: false,
    pendingPrompt: `<app-message source="app:invoices">\n${summary}\n</app-message>`,
    createdAt: new Date().toISOString(),
  });

  it("keeps the card with its hidden conversation, marks the way back with a dot, and restores the action with the tile", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await focusTile(primary!);

    await act(async () => {
      emitOverlayShow(appCard("app:invoices:e3", `session-${second!.chatGroupId}`, "reconcile the ledger"));
    });
    await waitFor(() => {
      expect(second!.element.querySelector('[data-testid="overlay-card-region"]')).not.toBeNull();
    });
    expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).toBeNull();

    // Hidden origin cards wait with their conversation; mark the control that restores it.
    await toggleTileMaximized(primary!);
    await waitFor(() => {
      expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).not.toBeNull();
    });
    expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(0);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    // Restoring the origin tile returns its card without changing the action's target.
    await toggleTileMaximized(primary!);
    await waitFor(() => {
      expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).toBeNull();
    });
    const tiles = collectTiles(container);
    const origin = tiles.find((tile) => tile.chatGroupId === second!.chatGroupId)!;
    const confirm = await waitFor(() => {
      const button = origin.element.querySelector<HTMLButtonElement>(
        '[data-testid="overlay-card-primary-action"]',
      );
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => {
      expect(origin.element.textContent).toContain("reconcile the ledger");
    });
    const other = tiles.find((tile) => tile.chatGroupId !== second!.chatGroupId)!;
    expect(other.element.textContent).not.toContain("reconcile the ledger");
  });
});

describe("overlay cards in a pane routed off its conversation", () => {
  // App messages without origin follow focus; plugin cards always name Suggestions.
  const pluginCard = (id: string, summary: string) => ({
    id,
    source: { kind: "app", serverId: "mail-assistant", eventId: id },
    title: "mail-action",
    summary,
    running: false,
    pendingPrompt: `<plugin-message source="plugin:mail-assistant">\n${summary}\n</plugin-message>`,
    createdAt: new Date().toISOString(),
  });
  const routedShell = (container: HTMLElement, view: string) =>
    container.querySelector<HTMLElement>(`[data-testid="main-pane-shell"][data-view="${view}"]`);
  const regions = (root: ParentNode) => root.querySelectorAll('[data-testid="overlay-card-region"]');
  const expectInFrameLane = (frame: HTMLElement, region: HTMLElement) => {
    const lane = region.closest<HTMLElement>('[data-testid="floating-right-lane"]');
    expect(lane).not.toBeNull();
    expect(frame.querySelector("[data-body-inset]")!.contains(lane)).toBe(true);
    expect(frame.querySelector('[data-testid="pane-header"]')!.contains(lane)).toBe(false);
  };

  it("draws a card with no origin in the frame of the pane it arrived over while that pane shows the work board — not in the window band", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    await clickSidebarNavRow("features", "toolbar-work-board");
    const shell = await waitFor(() => {
      const routed = routedShell(container, "work-board");
      expect(routed).not.toBeNull();
      return routed!;
    });
    const cell = container.querySelector<HTMLElement>(`[data-testid="pane-cell:${MAIN_CHAT_GROUP_ID}"]`)!;
    expect(cell.contains(shell)).toBe(true);
    expect(cell.getAttribute("data-hidden")).toBeNull();

    await act(async () => {
      emitOverlayShow(pluginCard("plugin:mail:e1", "메일에 답장할까요?"));
    });

    const region = await waitFor(() => {
      const drawn = container.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
      expect(drawn).not.toBeNull();
      return drawn!;
    });
    expect(regions(container)).toHaveLength(1);
    expect(shell.contains(region)).toBe(true);
    expect(region.getAttribute("data-overlay-surface")).toBe(MAIN_CHAT_GROUP_ID);
    expect(region.textContent).toContain("메일에 답장할까요?");
    const frame = shell.querySelector<HTMLElement>('[data-testid="pane"]')!;
    expectInFrameLane(frame, region);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    await act(async () => {
      fireEvent.click(frame.querySelector('[data-testid="pane-close"]')!);
    });
    await waitFor(() => expect(routedShell(container, "work-board")).toBeNull());
    const homeRegion = await waitFor(() => {
      const drawn = cell.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
      expect(drawn).not.toBeNull();
      return drawn!;
    });
    expect(regions(container)).toHaveLength(1);
    expect(homeRegion.getAttribute("data-overlay-surface")).toBe(MAIN_CHAT_GROUP_ID);
    expectInFrameLane(cell.querySelector<HTMLElement>('[data-testid="pane"]')!, homeRegion);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();
  });

  it("with two panes, draws the card in the focused pane — routed or not — and moves it when focus moves", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await clickSidebarNavRow("features", "toolbar-work-board");
    const shell = await waitFor(() => {
      const routed = routedShell(container, "work-board");
      expect(routed).not.toBeNull();
      return routed!;
    });
    expect(second!.element.contains(shell)).toBe(true);
    expect(primary!.element.contains(shell)).toBe(false);

    await act(async () => {
      emitOverlayShow(pluginCard("plugin:mail:e2", "두 번째 판에 도착한 카드"));
    });
    await waitFor(() => expect(regions(second!.element)).toHaveLength(1));
    expect(shell.contains(second!.element.querySelector('[data-testid="overlay-card-region"]'))).toBe(true);
    expect(regions(primary!.element)).toHaveLength(0);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    await focusTile(primary!);
    const moved = await waitFor(() => {
      const region = primary!.element.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
      expect(region).not.toBeNull();
      return region!;
    });
    expect(regions(second!.element)).toHaveLength(0);
    expect(regions(container)).toHaveLength(1);
    expectInFrameLane(primary!.element.querySelector<HTMLElement>('[data-testid="pane"]')!, moved);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();
  });
});

describe("overlay queue navigation with two tiles", () => {
  it("counts and steps through each surface's own cards", async () => {
    const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await focusTile(primary!);

    const card = (id: string, originSessionId: string | undefined, summary: string) => ({
      id,
      source: { kind: "app", serverId: "invoices", eventId: id },
      ...(originSessionId === undefined ? {} : { originSessionId }),
      title: "invoices",
      summary,
      running: false,
      pendingPrompt: `<app-message source="app:invoices">\n${summary}\n</app-message>`,
      createdAt: new Date().toISOString(),
    });

    await act(async () => {
      emitOverlayShow(card("a1", undefined, "first for the window"));
      emitOverlayShow(card("b1", `session-${second!.chatGroupId}`, "only for the other tile"));
      emitOverlayShow(card("a2", undefined, "second for the window"));
    });

    const indicator = (root: HTMLElement | null | undefined) =>
      root?.querySelector('[data-testid="routine-card-indicator"]')?.textContent;
    // Counters describe each surface's own queue slice rather than the whole window.
    await waitFor(() => expect(indicator(primary!.element)).toBe("2/2"));
    expect(primary!.element.textContent).toContain("second for the window");
    expect(indicator(second!.element)).toBeUndefined();
    expect(second!.element.textContent).toContain("only for the other tile");
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    // Queue navigation stays inside the surface's slice.
    const back = primary!.element.querySelector<HTMLButtonElement>('[data-testid="overlay-card-prev"]')!;
    await act(async () => {
      fireEvent.click(back);
    });
    await waitFor(() => expect(indicator(primary!.element)).toBe("1/2"));
    expect(primary!.element.textContent).toContain("first for the window");
    expect(primary!.element.textContent).not.toContain("only for the other tile");
  });
});

describe("an unowned card follows focus without losing its state", () => {
  it("keeps the expanded summary and the original timestamp across a focus change", async () => {
    const restoreOverflow = forceOverflowingSummaries();
    try {
      const { container, emitOverlayShow } = await renderApp({ hasApiKey: true });
      const [primary, second] = await splitIntoTwoTiles(container);
      await focusTile(primary!);

      // Unowned app cards follow focus while retaining their user-controlled state.
      const createdAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await act(async () => {
        emitOverlayShow({
          id: "app:notes:e1",
          source: { kind: "app", serverId: "notes", eventId: "e1" },
          title: "notes",
          summary: "긴 요약 ".repeat(50),
          running: false,
          pendingPrompt: "<untrusted-plugin>notes</untrusted-plugin>",
          createdAt,
        });
      });

      const shownRegion = () =>
        primary!.element.querySelector<HTMLElement>('[data-testid="overlay-card-region"]')!;
      const toggle = await waitFor(() => {
        const button = shownRegion().querySelector<HTMLButtonElement>(
          '[data-testid="overlay-card-expand-toggle"]',
        );
        expect(button).not.toBeNull();
        return button!;
      });
      await act(async () => {
        fireEvent.click(toggle);
      });
      expect(
        shownRegion().querySelector('[data-testid="overlay-card-summary"]')
          ?.getAttribute("data-expanded"),
      ).toBe("true");
      expect(shownRegion().textContent).toContain("10분 전");

      await focusTile(second!);

      // Moving a card must preserve controlled expansion and the original host timestamp.
      const movedRegion = await waitFor(() => {
        const region = second!.element.querySelector<HTMLElement>('[data-testid="overlay-card-region"]');
        expect(region).not.toBeNull();
        return region!;
      });
      expect(container.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(1);
      expect(primary!.element.querySelectorAll('[data-testid="overlay-card-region"]')).toHaveLength(0);
      expect(
        movedRegion.querySelector('[data-testid="overlay-card-summary"]')
          ?.getAttribute("data-expanded"),
      ).toBe("true");
      expect(movedRegion.textContent).toContain("10분 전");
      expect(movedRegion.textContent).not.toContain("방금");
    } finally {
      restoreOverflow();
    }
  });
});

describe("a turn parked on an approval, with two tiles", () => {
  const request = (overrides: Record<string, unknown>) =>
    approvalRequest({
      id: "req-parked-turn",
      nonce: "nonce-parked-turn",
      hmac: "hmac-parked-turn",
      ...overrides,
    });
  const band = (tile: { element: HTMLElement }) =>
    tile.element.querySelector('[data-testid="approval-waiting-band"]');
  const dock = (within: HTMLElement) =>
    within.querySelectorAll('[data-testid="approval-dock"]');
  const laneCard = (within: HTMLElement) =>
    within.querySelectorAll('[data-testid="approval-lane-card"]');
  const pluginSidebarView = (pluginId: string, viewId: string) => ({
    pluginId,
    extension: { id: viewId, slot: "sidebar", kind: "embedded-module", title: "Inbox", entry: "ui/index.js", exportName: "mount" },
    entryUrl: "file:///plugins/example/dist/ui/index.js",
  });

  it("draws the card and the waiting band in the tile holding the session that asked, and nowhere else, until the card is answered", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });

    await waitFor(() => expect(dock(second!.element)).toHaveLength(1));
    expect(dock(primary!.element)).toHaveLength(0);
    expect(dock(container)).toHaveLength(1);
    await waitFor(() => expect(band(second!)).not.toBeNull());
    expect(band(second!)!.getAttribute("data-tool-names")).toBe("read_file");
    expect(band(primary!)).toBeNull();

    const deny = second!.element.querySelector<HTMLButtonElement>('[data-testid="deny-button"]');
    expect(deny).not.toBeNull();
    await act(async () => {
      fireEvent.click(deny!);
    });

    await waitFor(() => expect(band(second!)).toBeNull());
    await waitFor(() => expect(dock(container)).toHaveLength(0));
  });

  it("calls the conversation by its title on the card, and keeps the id for the review details", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });

    await waitFor(() => expect(dock(second!.element)).toHaveLength(1));
    const label = second!.element.querySelector('[data-testid="approval-conversation"]');
    expect(label?.textContent).not.toContain(`session-${second!.chatGroupId}`);
    expect(label?.textContent?.trim().length).toBeGreaterThan(0);
    expect(
      second!.element.querySelector('[data-testid="approval-conversation-id"]')?.textContent,
    ).toContain(`session-${second!.chatGroupId}`);
  });

  it("tells the waiting tile that its queued messages are held by the approval", async () => {
    const { container, api, emitApproval } = await renderApp({
      hasApiKey: true,
      aveEnv: { isDev: true, isE2E: true },
    });
    const [primary, second] = await splitIntoTwoTiles(container);

    // Keep a turn pending so subsequent input enters the queue.
    api.chatSend.mockImplementationOnce(() => new Promise(() => {}));
    await submitChatMessage(second!.element, "첫 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await submitChatMessage(second!.element, "이어서 부탁");
    await waitFor(() =>
      expect(second!.element.querySelector('[data-testid="message-queue-panel"]')).not.toBeNull(),
    );
    expect(second!.element.querySelector('[data-testid="message-queue-held-by-approval"]')).toBeNull();

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });

    await waitFor(() =>
      expect(second!.element.querySelector('[data-testid="message-queue-held-by-approval"]')).not.toBeNull(),
    );
    expect(primary!.element.querySelector('[data-testid="message-queue-panel"]')).toBeNull();
  });

  it("names what was blocked in that tile's transcript when the turn ends unanswered, and lets the dead card go", async () => {
    const { container, emitApproval, emitChatStream } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });
    await waitFor(() => expect(band(second!)).not.toBeNull());

    await act(async () => {
      emitChatStream({ type: "done" });
    });

    await waitFor(() => {
      const notices = Array.from(second!.element.querySelectorAll('[data-testid="system-entry"]'));
      expect(notices.some((el) => el.textContent?.includes("read_file"))).toBe(true);
    });
    expect(
      Array.from(primary!.element.querySelectorAll('[data-testid="system-entry"]'))
        .some((el) => el.textContent?.includes("read_file")),
    ).toBe(false);
    expect(band(second!)).toBeNull();
    await waitFor(() => expect(dock(container)).toHaveLength(0));
  });

  it("brings a request the host was already parked on back after a reload, in the tile holding its session", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      pendingApprovals: [request({ sessionId: MOCK_DEFAULT_SESSION_ID })],
    });

    const [primary] = collectTiles(container);
    await waitFor(() => expect(band(primary!)).not.toBeNull());
    expect(band(primary!)!.getAttribute("data-tool-names")).toBe("read_file");
    await waitFor(() => expect(dock(primary!.element)).toHaveLength(1));
  });

  it("draws a request parked before this tile knew its session once: in the tile, never beside it in the lane", async () => {
    // Before hydration, unmatched approvals use the focused lane; move them when session ownership becomes known.
    let resolveHistory!: (history: { sessionId: string; messages: never[] }) => void;
    const history = new Promise<{ sessionId: string; messages: never[] }>((resolve) => {
      resolveHistory = resolve;
    });
    const { container } = await renderApp({
      hasApiKey: true,
      history,
      pendingApprovals: [request({ sessionId: MOCK_DEFAULT_SESSION_ID })],
    });
    await waitFor(() => expect(laneCard(container)).toHaveLength(1));
    expect(dock(container)).toHaveLength(0);

    await act(async () => {
      resolveHistory({ sessionId: MOCK_DEFAULT_SESSION_ID, messages: [] });
    });
    const [primary] = collectTiles(container);
    await waitFor(() => expect(dock(primary!.element)).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(laneCard(container)).toHaveLength(0);
    expect(band(primary!)!.getAttribute("data-tool-names")).toBe("read_file");
  });

  it("draws a request that names no conversation as a lane card in the focused pane, covering no composer", async () => {
    const { container, emitApproval } = await renderApp({
      hasApiKey: true,
      pluginUiExtensions: [pluginSidebarView("mail-assistant", "inbox")],
    });
    const [primary, second] = await splitIntoTwoTiles(container);
    await act(async () => {
      emitApproval(request({ id: "req-host" }));
    });

    await waitFor(() => expect(laneCard(second!.element)).toHaveLength(1));
    expect(laneCard(container)).toHaveLength(1);
    expect(laneCard(primary!.element)).toHaveLength(0);
    expect(dock(container)).toHaveLength(0);
    expect(band(primary!)).toBeNull();
    expect(band(second!)).toBeNull();
    expect(second!.element.querySelector('[data-testid="approval-lane-card"]')!.textContent).toContain("호스트 요청");
    expect(container.querySelector('[data-testid="sidebar-group-plugins-pending-answer"]')).not.toBeNull();
    for (const tile of [primary!, second!]) {
      const composer = tile.element.querySelector<HTMLElement>("[data-composer-placement]")!;
      expect(composer).not.toHaveAttribute("inert");
      const input = tile.element.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        input.focus();
      });
      await advanceAnimationFrame();
      expect(document.activeElement).toBe(input);
    }
  });

  it("moves the lane card with focus, and names the plugin that asked", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ id: "req-plugin", sourcePluginId: "mail-assistant" }));
    });
    await waitFor(() => expect(laneCard(second!.element)).toHaveLength(1));
    expect(second!.element.querySelector('[data-testid="approval-lane-card"]')!.textContent)
      .toContain("익스텐션 요청 · mail-assistant");
    expect(laneCard(container)[0]!.closest('[data-testid="floating-right-lane"]')).not.toBeNull();

    await focusTile(primary!);
    await waitFor(() => expect(laneCard(primary!.element)).toHaveLength(1));
    expect(laneCard(second!.element)).toHaveLength(0);
    expect(laneCard(container)).toHaveLength(1);
    expect(container.querySelector('[data-testid="window-approval-scope"]')).toBeNull();
  });

  it("keeps a maximized-away pane's approval in that pane, undrawn, and marks the way back", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [primary, second] = await splitIntoTwoTiles(container);
    await focusTile(primary!);

    await act(async () => {
      emitApproval(request({ sessionId: `session-${second!.chatGroupId}` }));
    });
    await waitFor(() => expect(dock(second!.element)).toHaveLength(1));
    expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).toBeNull();

    // Hidden pane cards stay owned and signal the restore control rather than moving to a visible neighbor.
    await toggleTileMaximized(primary!);
    await waitFor(() => {
      expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).not.toBeNull();
    });
    expect(dock(container)).toHaveLength(0);
    expect(laneCard(container)).toHaveLength(0);
    expect(container.querySelector('[data-testid="window-approval-scope"]')).toBeNull();

    await toggleTileMaximized(primary!);
    const restored = collectTiles(container).find((tile) => tile.chatGroupId === second!.chatGroupId)!;
    await waitFor(() => expect(dock(restored.element)).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(primary!.element.querySelector('[data-testid="pane-maximize-pending-answer"]')).toBeNull();
  });

  it("keeps first-send side-chat questions and approvals exclusive before its surface publishes", async () => {
    const { container, api, emitAskUserQuestion, emitApproval } = await renderApp({ hasApiKey: true, sideChat: true });
    const side = api.sideChat as unknown as NonNullable<AveApi["sideChat"]>;
    const turn = deferred<{ ok: true; result: {} }>();
    const streams = new Set<Parameters<typeof side.onStream>[0]>();
    vi.mocked(side.send).mockReturnValueOnce(turn.promise);
    vi.mocked(side.onStream).mockImplementation((handler) => {
      streams.add(handler);
      return () => { streams.delete(handler); };
    });
    await act(async () => {
      fireEvent.click(container.querySelector(`[data-testid="${TEST_IDS.panePanelToggle}"]`)!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector(`[data-testid="${chatSidePanelLauncherTestId("side-chat")}"]`)!);
    });
    const sideView = container.querySelector<HTMLElement>('[data-testid="side-chat-view"]')!;
    try {
      await act(async () => {
        fireEvent.change(sideView.querySelector('[data-testid="composer-textarea"]')!, { target: { value: "First side turn" } });
        fireEvent.click(sideView.querySelector('[data-testid="composer-send-button"]')!);
      });
      expect(side.send).toHaveBeenCalledOnce();
      expect(side.new).not.toHaveBeenCalled();
      expect(side.load).not.toHaveBeenCalled();
      expect(streams.size).toBeGreaterThan(0);
      await act(async () => {
        for (const stream of streams) stream({ type: "user_message", sessionId: MOCK_SIDE_CHAT_SESSION_ID, streamId: 1, sendRequestId: vi.mocked(side.send).mock.calls.at(-1)![3] });
        emitAskUserQuestion({
          id: "ask-first-side", sessionId: MOCK_SIDE_CHAT_SESSION_ID, createdAt: Date.now(),
          questions: [{ question: "Question for the first side turn", choices: ["Continue", "Stop"] }],
        });
        emitApproval(approvalRequest({ id: "approval-first-side", sessionId: MOCK_SIDE_CHAT_SESSION_ID }));
      });
      await waitFor(() => expect(sideView.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(1));
      expect(container.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(1);
      expect(sideView.querySelectorAll('[data-testid="approval-dock"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-testid="approval-dock"]')).toHaveLength(1);
      expect(container.querySelector('[data-testid="approval-lane-card"]')).toBeNull();
    } finally {
      await act(async () => {
        turn.resolve({ ok: true, result: {} });
        await turn.promise;
      });
    }
  });

  it("keeps a first side-chat turn's cards out of another tile's idle side view", async () => {
    const { container, api, emitAskUserQuestion, emitApproval } = await renderApp({ hasApiKey: true, sideChat: true });
    const [sender, peer] = await splitIntoTwoTiles(container);
    const side = api.sideChat as unknown as NonNullable<AveApi["sideChat"]>;
    const streams = new Set<Parameters<typeof side.onStream>[0]>();
    vi.mocked(side.onStream).mockImplementation((handler) => {
      streams.add(handler);
      return () => { streams.delete(handler); };
    });
    const turn = deferred<{ ok: true; result: {} }>();
    vi.mocked(side.send).mockReturnValueOnce(turn.promise);
    for (const tile of [sender!, peer!]) {
      await act(async () => { fireEvent.click(tile.element.querySelector(testIdSelector(TEST_IDS.panePanelToggle))!); });
      await act(async () => { fireEvent.click(tile.element.querySelector(`[data-testid="${chatSidePanelLauncherTestId("side-chat")}"]`)!); });
    }
    const senderView = sender!.element.querySelector<HTMLElement>('[data-testid="side-chat-view"]')!;
    const peerView = peer!.element.querySelector<HTMLElement>('[data-testid="side-chat-view"]')!;
    try {
      await act(async () => {
        fireEvent.change(senderView.querySelector('[data-testid="composer-textarea"]')!, { target: { value: "First side turn" } });
        fireEvent.click(senderView.querySelector('[data-testid="composer-send-button"]')!);
      });
      expect(side.send).toHaveBeenCalledOnce();
      expect(side.new).not.toHaveBeenCalled();
      expect(side.load).not.toHaveBeenCalled();
      await act(async () => {
        for (const stream of streams) stream({ type: "user_message", sessionId: MOCK_SIDE_CHAT_SESSION_ID, streamId: 1, sendRequestId: vi.mocked(side.send).mock.calls[0]![3] });
        emitAskUserQuestion({ id: "ask-side-owner", sessionId: MOCK_SIDE_CHAT_SESSION_ID, createdAt: Date.now(), questions: [{ question: "Question for the sender", choices: ["Continue", "Stop"] }] });
        emitApproval(approvalRequest({ id: "approval-side-owner", sessionId: MOCK_SIDE_CHAT_SESSION_ID }));
      });
      await waitFor(() => expect(senderView.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(1));
      expect(senderView.querySelectorAll('[data-testid="approval-dock"]')).toHaveLength(1);
      expect(peerView.querySelectorAll(BLOCKING_SURFACE_SELECTOR)).toHaveLength(0);
      expect(container.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(1);
      expect(container.querySelectorAll('[data-testid="approval-dock"]')).toHaveLength(1);
    } finally {
      await act(async () => { turn.resolve({ ok: true, result: {} }); await turn.promise; });
    }
  });

  it.each(["question", "approval", "child", "closed-child", "combined", "closed-combined"] as const)("transfers a retained side session's %s ownership on sequential sends and back", async (surface) => {
    const { container, api, emitAskUserQuestion, emitApproval, emitApprovalSettled, emitAgentSpawnEvent } = await renderApp({ hasApiKey: true, sideChat: true });
    const [first, second] = await splitIntoTwoTiles(container);
    const side = api.sideChat as unknown as NonNullable<AveApi["sideChat"]>;
    const streams = new Set<Parameters<typeof side.onStream>[0]>();
    vi.mocked(side.onStream).mockImplementation((handler) => {
      streams.add(handler);
      return () => { streams.delete(handler); };
    });
    const questionTimeouts = new Set<Parameters<NonNullable<typeof api.onAskUserQuestionTimeout>>[0]>();
    vi.mocked(api.onAskUserQuestionTimeout!).mockImplementation((handler) => {
      questionTimeouts.add(handler);
      return () => { questionTimeouts.delete(handler); };
    });
    const turns = Array.from({ length: 3 }, () => deferred<{ ok: true; result: {} }>());
    for (const turn of turns) vi.mocked(side.send).mockReturnValueOnce(turn.promise);
    for (const tile of [first!, second!]) {
      await act(async () => { fireEvent.click(tile.element.querySelector(testIdSelector(TEST_IDS.panePanelToggle))!); });
      await act(async () => { fireEvent.click(tile.element.querySelector(`[data-testid="${chatSidePanelLauncherTestId("side-chat")}"]`)!); });
    }
    const hasCombinedSurfaces = surface === "combined" || surface === "closed-combined";
    const hasQuestion = surface === "question" || hasCombinedSurfaces;
    const hasApproval = surface === "approval" || hasCombinedSurfaces;
    const hasChildren = surface === "child" || surface === "closed-child" || hasCombinedSurfaces;
    const isClosed = surface === "closed-child" || surface === "closed-combined";
    const showTab = async (tile: NonNullable<typeof first>, kind: "subagent" | "side-chat") => {
      await act(async () => {
        const add = tile.element.querySelector('[data-testid="chat-side-panel-add-tab"]')!;
        fireEvent.pointerDown(add, { button: 0 });
        fireEvent.click(add);
      });
      const item = await waitFor(() => {
        const menu = document.querySelector('[role="menu"][data-state="open"]');
        const target = menu?.querySelector(`[data-testid="${chatSidePanelLauncherTestId(`menu-${kind}`)}"]`) ?? null;
        expect(target).not.toBeNull();
        return target!;
      });
      await act(async () => { fireEvent.click(item); });
      await waitFor(() => expect(tile.element.querySelector(`[data-testid="chat-side-panel-tab-${kind}"][aria-selected="true"]`))
        .not.toBeNull());
    };
    const childTitles = (tile: NonNullable<typeof first>) => Array.from(tile.element.querySelectorAll('[data-testid="chat-side-panel-subagent-row"]'), (row) => row.textContent);
    const finish = async (number: number) => {
      const refreshes = vi.mocked(api.chatSessions).mock.calls.length;
      await act(async () => {
        if (hasApproval) emitApprovalSettled(`approval-transfer-${number}`);
        if (hasQuestion) for (const handler of questionTimeouts) handler({ requestId: `ask-transfer-${number}` });
      });
      await waitFor(() => {
        expect(container.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(0);
        expect(container.querySelectorAll('[data-testid="approval-dock"]')).toHaveLength(0);
      });
      await act(async () => {
        for (const stream of streams) stream({ type: "done", streamId: number });
        turns[number - 1]!.resolve({ ok: true, result: {} });
        await turns[number - 1]!.promise;
      });
      await waitFor(() => expect(api.chatSessions).toHaveBeenCalledTimes(refreshes + 1));
      await act(async () => { await vi.mocked(api.chatSessions).mock.results[refreshes]!.value; });
    };
    try {
      for (const number of [1, 2, 3]) {
        const senderIndex = number === 2 ? 1 : 0;
        if (number === 3 && hasChildren) {
          if (isClosed) await showTab(first!, "side-chat");
          else await act(async () => { fireEvent.click(first!.element.querySelector('[data-testid="chat-side-panel-tab-side-chat"]')!); });
        }
        const tiles = [first!, second!];
        const sender = tiles[senderIndex]!.element.querySelector<HTMLElement>('[data-testid="side-chat-view"]')!;
        const peer = tiles[1 - senderIndex]!.element.querySelector<HTMLElement>('[data-testid="side-chat-view"]');
        await act(async () => {
          fireEvent.change(sender.querySelector('[data-testid="composer-textarea"]')!, { target: { value: `Side turn ${number}` } });
          fireEvent.click(sender.querySelector('[data-testid="composer-send-button"]')!);
        });
        expect(side.send).toHaveBeenCalledTimes(number);
        await act(async () => {
          for (const stream of streams) stream({ type: "user_message", sessionId: MOCK_SIDE_CHAT_SESSION_ID, streamId: number, sendRequestId: vi.mocked(side.send).mock.calls[number - 1]![3] });
          if (hasQuestion) {
            emitAskUserQuestion({ id: `ask-transfer-${number}`, sessionId: MOCK_SIDE_CHAT_SESSION_ID, createdAt: Date.now(), questions: [{ question: `Question for turn ${number}`, choices: ["Continue", "Stop"] }] });
          }
          if (hasApproval) {
            emitApproval(approvalRequest({ id: `approval-transfer-${number}`, sessionId: MOCK_SIDE_CHAT_SESSION_ID }));
          }
          if (hasChildren) {
            emitAgentSpawnEvent({ type: "start", spawnId: `child-transfer-${number}`, parentSessionId: MOCK_SIDE_CHAT_SESSION_ID, taskState: A2ATaskState.SUBMITTED, title: `Child from turn ${number}` });
            emitAgentSpawnEvent({ type: "done", spawnId: `child-transfer-${number}`, parentSessionId: MOCK_SIDE_CHAT_SESSION_ID, taskState: A2ATaskState.COMPLETED, title: `Child from turn ${number}`, entries: [], toolCallCount: 0 });
          }
        });
        for (const testId of [...(hasQuestion ? ["question-overlay"] : []), ...(hasApproval ? ["approval-dock"] : [])]) {
          const selector = `[data-testid="${testId}"]`;
          await waitFor(() => expect(sender.querySelectorAll(selector)).toHaveLength(1));
          expect(peer?.querySelectorAll(selector) ?? []).toHaveLength(0);
          expect(container.querySelectorAll(selector)).toHaveLength(1);
        }
        if (hasChildren && number >= 2) {
          await finish(number);
          await showTab(first!, "subagent");
          if (number === 2) await showTab(second!, "subagent");
          await waitFor(() => expect(childTitles(second!)).toEqual([expect.stringContaining("Child from turn 2")]));
          expect(childTitles(first!)).toEqual(number === 2
            ? [expect.stringContaining("Child from turn 1")]
            : [expect.stringContaining("Child from turn 1"), expect.stringContaining("Child from turn 3")]);
          continue;
        }
        await finish(number);
        if (number === 1 && isClosed) {
          await showTab(first!, "subagent");
          const tab = first!.element.querySelector('[data-testid="chat-side-panel-tab-side-chat"]')!;
          await act(async () => { fireEvent.click(Array.from(tab.parentElement!.querySelectorAll("button")).at(-1)!); });
          expect(first!.element.querySelector('[data-testid="side-chat-view"]')).toBeNull();
          expect(childTitles(first!)).toEqual([expect.stringContaining("Child from turn 1")]);
        }
      }
      expect(side.new).not.toHaveBeenCalled();
      expect(side.load).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        for (const turn of turns) turn.resolve({ ok: true, result: {} });
        await Promise.all(turns.map((turn) => turn.promise));
      });
    }
  });

  it("draws a side chat's approval over the side composer, and marks the panel toggle and the tab while it is out of sight", async () => {
    // Use a controlled clock to assert the settled panel-close state.
    vi.useRealTimers();
    const { container, api, emitApproval } = await renderApp({ hasApiKey: true, sideChat: true });
    const toggle = () => container.querySelector<HTMLButtonElement>(testIdSelector(TEST_IDS.panePanelToggle))!;
    await act(async () => { fireEvent.click(toggle()); });
    await act(async () => {
      fireEvent.click(container.querySelector(`[data-testid="${chatSidePanelLauncherTestId("side-chat")}"]`)!);
    });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="side-chat-new"]')!);
    });
    const sideChatNew = (api.sideChat as unknown as { new: ReturnType<typeof vi.fn> }).new;
    await waitFor(() => expect(sideChatNew).toHaveBeenCalled());

    await act(async () => {
      emitApproval(request({ id: "req-side", sessionId: MOCK_SIDE_CHAT_SESSION_ID }));
    });
    const sideView = () => container.querySelector<HTMLElement>('[data-testid="side-chat-view"]')!;
    await waitFor(() => expect(dock(sideView())).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(container.querySelector('[data-testid="pane-panel-toggle-pending-answer"]')).toBeNull();

    const add = container.querySelector<HTMLElement>('[data-testid="chat-side-panel-add-tab"]')!;
    await act(async () => {
      fireEvent.pointerDown(add, { button: 0 });
      fireEvent.click(add);
    });
    await act(async () => {
      fireEvent.click(await waitFor(() => {
        const item = container.querySelector<HTMLElement>(`[data-testid="${chatSidePanelLauncherTestId("menu-browser")}"]`)
          ?? document.querySelector<HTMLElement>(`[data-testid="${chatSidePanelLauncherTestId("menu-browser")}"]`);
        expect(item).not.toBeNull();
        return item!;
      }));
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="chat-side-panel-tab-side-chat-pending-answer"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="pane-panel-toggle-pending-answer"]')).not.toBeNull();

    // Closing the panel must preserve side-chat ownership and its parked request through the transition.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => { fireEvent.click(toggle()); });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    } finally {
      vi.useRealTimers();
    }
    expect(container.querySelector('[data-testid="side-chat-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="chat-side-panel-motion"]')).toHaveStyle({ display: "none" });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="pane-panel-toggle-pending-answer"]')).not.toBeNull();
    });
    expect(dock(container)).toHaveLength(1);
    const tileComposer = container.querySelector<HTMLElement>('[data-testid="chat-main-column"] [data-composer-placement]')!;
    expect(tileComposer).not.toHaveAttribute("inert");

    await act(async () => { fireEvent.click(toggle()); });
    await act(async () => {
      fireEvent.click(container.querySelector('[data-testid="chat-side-panel-tab-side-chat"]')!);
    });
    await waitFor(() => expect(dock(sideView())).toHaveLength(1));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="pane-panel-toggle-pending-answer"]')).toBeNull();
    });
    expect(container.querySelector('[data-testid="chat-side-panel-tab-side-chat-pending-answer"]')).toBeNull();
  });

  it("opening a side chat from its sidebar row does not pin the panel to that tab afterwards", async () => {
    const parent = { id: MOCK_DEFAULT_SESSION_ID, title: "부모 대화", modifiedAt: new Date(2, 0, 2).toISOString() };
    const { container, api } = await renderApp({
      hasApiKey: true,
      sideChat: true,
      sessions: [
        parent,
        { ...parent, id: MOCK_SIDE_CHAT_SESSION_ID, title: "사이드 챗", family: "side-chat", originSessionId: MOCK_DEFAULT_SESSION_ID },
      ],
    });
    const sidebarToggle = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-collapse-toggle"]');
    if (sidebarToggle && sidebarToggle.getAttribute("aria-pressed") !== "true") {
      await act(async () => { fireEvent.click(sidebarToggle); });
    }
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(`[data-testid="sidebar-session-${MOCK_SIDE_CHAT_SESSION_ID}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => { fireEvent.click(row); });
    const sideChatLoad = (api.sideChat as unknown as { load: ReturnType<typeof vi.fn> }).load;
    await waitFor(() => expect(sideChatLoad).toHaveBeenCalledWith(MOCK_SIDE_CHAT_SESSION_ID));
    const tab = (kind: string) => container.querySelector<HTMLElement>(`[data-testid="chat-side-panel-tab-${kind}"]`);
    await waitFor(() => expect(tab("side-chat")?.getAttribute("aria-selected")).toBe("true"));

    // Auto-open each request once; later user tab navigation must persist across rerenders.
    const add = container.querySelector<HTMLElement>('[data-testid="chat-side-panel-add-tab"]')!;
    await act(async () => {
      fireEvent.pointerDown(add, { button: 0 });
      fireEvent.click(add);
    });
    const menuBrowser = await waitFor(() => {
      const item = document.querySelector<HTMLElement>(`[data-testid="${chatSidePanelLauncherTestId("menu-browser")}"]`);
      expect(item).not.toBeNull();
      return item!;
    });
    await act(async () => { fireEvent.click(menuBrowser); });
    await waitFor(() => expect(tab("browser")?.getAttribute("aria-selected")).toBe("true"));
    await act(async () => { fireEvent.click(tab("side-chat")!); });
    await waitFor(() => expect(tab("side-chat")?.getAttribute("aria-selected")).toBe("true"));
    await act(async () => { fireEvent.click(tab("browser")!); });
    await waitFor(() => expect(tab("browser")?.getAttribute("aria-selected")).toBe("true"));
    expect(tab("side-chat")?.getAttribute("aria-selected")).toBe("false");

    const toggle = container.querySelector<HTMLButtonElement>(testIdSelector(TEST_IDS.panePanelToggle))!;
    await act(async () => { fireEvent.click(toggle); });
    await waitFor(() => expect(toggle.getAttribute("aria-pressed")).toBe("false"));
  });

  it("takes the lane card down when the host retires the request", async () => {
    const { container, emitApproval, emitApprovalSettled } = await renderApp({ hasApiKey: true });
    await splitIntoTwoTiles(container);

    await act(async () => {
      emitApproval(request({ id: "req-host" }));
    });
    await waitFor(() => expect(laneCard(container)).toHaveLength(1));

    // Host cancellation must retire requests after the asking tile closes.
    await act(async () => {
      emitApprovalSettled("req-host");
    });

    await waitFor(() => expect(laneCard(container)).toHaveLength(0));
  });
});

describe("cards raised by one of three tiles", () => {
  const request = (overrides: Record<string, unknown>) =>
    approvalRequest({
      id: "req-middle-tile",
      toolName: "write_file",
      toolCategory: "write",
      args: { path: "/tmp/out.md" },
      reason: "write the summary",
      nonce: "nonce-middle-tile",
      hmac: "hmac-middle-tile",
      ...overrides,
    });
  const dock = (within: HTMLElement) =>
    within.querySelectorAll('[data-testid="approval-dock"]');
  const composer = (tile: { element: HTMLElement }) =>
    tile.element.querySelector<HTMLElement>('[data-composer-placement]');
  const textarea = (tile: { element: HTMLElement }) =>
    tile.element.querySelector<HTMLTextAreaElement>("textarea");
  const band = (tile: { element: HTMLElement }) =>
    tile.element.querySelector('[data-testid="approval-waiting-band"]');
  const tileCell = (node: Element) =>
    node.closest<HTMLElement>('[data-testid^="pane-cell:"]');
  // Other tiles must remain interactive while one conversation waits for approval.
  const expectUntouched = async (...others: Array<{ element: HTMLElement }>) => {
    for (const tile of others) {
      expect(tile.element.querySelectorAll(BLOCKING_SURFACE_SELECTOR)).toHaveLength(0);
      expect(composer(tile)).not.toHaveAttribute("inert");
      const input = textarea(tile)!;
      await act(async () => {
        input.focus();
      });
      await advanceAnimationFrame();
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: "옆 타일은 계속 입력" } });
      expect(input.value).toBe("옆 타일은 계속 입력");
    }
  };

  it("shows the approval card in the tile that asked, while the other two keep their composers, their focus, and their turns", async () => {
    const { container, api, emitApproval } = await renderApp({ hasApiKey: true });
    const [first, middle, third] = await splitIntoThreeTiles(container);

    await focusTile(first!);
    await act(async () => {
      textarea(first!)!.focus();
    });
    await advanceAnimationFrame();
    expect(document.activeElement).toBe(textarea(first!));

    await act(async () => {
      emitApproval(request({ sessionId: `session-${middle!.chatGroupId}` }));
    });

    await waitFor(() => expect(dock(middle!.element)).toHaveLength(1));
    expect(dock(first!.element)).toHaveLength(0);
    expect(dock(third!.element)).toHaveLength(0);
    expect(dock(container)).toHaveLength(1);

    await advanceAnimationFrame();
    expect(document.activeElement).toBe(textarea(first!));
    expect(tileCell(dock(container)[0]!)).toBe(middle!.element);
    expect(composer(middle!)).toHaveAttribute("inert");
    await expectUntouched(first!, third!);

    await submitChatMessage(first!.element, "첫 타일 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await focusTile(third!);
    await submitChatMessage(third!.element, "셋째 타일 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));
    expect(dock(middle!.element)).toHaveLength(1);

    const approve = middle!.element.querySelector<HTMLButtonElement>('[data-testid="approve-button"]');
    expect(approve).not.toBeNull();
    await act(async () => {
      fireEvent.click(approve!);
    });
    await waitFor(() => expect(dock(container)).toHaveLength(0));
    await waitFor(() => expect(composer(middle!)).not.toHaveAttribute("inert"));
  });

  it("shows a user-question card in the tile that asked, and only there, while another tile runs a turn", async () => {
    const { container, api, emitAskUserQuestion } = await renderApp({ hasApiKey: true });
    const [first, middle, third] = await splitIntoThreeTiles(container);

    await focusTile(first!);
    await act(async () => {
      textarea(first!)!.focus();
    });
    await advanceAnimationFrame();
    expect(document.activeElement).toBe(textarea(first!));

    await act(async () => {
      emitAskUserQuestion({
        id: "ask-middle",
        sessionId: `session-${middle!.chatGroupId}`,
        questions: [{ question: "어느 형식으로 정리할까요?", choices: ["표", "목록"] }],
        createdAt: Date.now(),
      });
    });

    const question = (tile: { element: HTMLElement }) =>
      tile.element.querySelector('[data-testid="question-overlay"]');
    await waitFor(() => expect(question(middle!)).not.toBeNull());
    expect(tileCell(question(middle!)!)).toBe(middle!.element);
    expect(container.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(1);
    // Wait through first-answer seating before proving the existing caret was not stolen.
    await advanceAnimationFrame();
    expect(document.activeElement).toBe(textarea(first!));
    await expectUntouched(first!, third!);

    await focusTile(first!);
    await submitChatMessage(first!.element, "첫 타일은 계속 진행");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    expect(question(middle!)).not.toBeNull();
    expect(question(first!)).toBeNull();
  });

  it("shows the sub-agent spawn card in the tile that asked, and only there", async () => {
    const { container, emitApproval } = await renderApp({ hasApiKey: true });
    const [first, middle, third] = await splitIntoThreeTiles(container);

    await focusTile(first!);
    await act(async () => {
      textarea(first!)!.focus();
    });

    // Spawn approval belongs to the spawning turn's tile.
    await act(async () => {
      emitApproval(request({
        id: "req-spawn-middle",
        toolName: "agent_spawn",
        toolCategory: "meta",
        args: { title: "메모 정리", instructions: "메모를 한 줄로 정리해" },
        reason: "spawn a sub-agent for the summary",
        nonce: "nonce-spawn-middle",
        hmac: "hmac-spawn-middle",
        sessionId: `session-${middle!.chatGroupId}`,
      }));
    });

    await waitFor(() => expect(dock(middle!.element)).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(tileCell(dock(container)[0]!)).toBe(middle!.element);
    expect(band(middle!)?.getAttribute("data-tool-names")).toBe("agent_spawn");
    expect(band(first!)).toBeNull();
    expect(band(third!)).toBeNull();

    await advanceAnimationFrame();
    expect(document.activeElement).toBe(textarea(first!));
    expect(composer(middle!)).toHaveAttribute("inert");
    await expectUntouched(first!, third!);
  });

  it("brings a spawn card the host was parked on back after a reload, into the tile holding its session", async () => {
    const { container } = await renderApp({
      hasApiKey: true,
      pendingApprovals: [request({
        id: "req-spawn-parked",
        toolName: "agent_spawn",
        toolCategory: "meta",
        args: { title: "메모 정리", instructions: "메모를 한 줄로 정리해" },
        sessionId: MOCK_DEFAULT_SESSION_ID,
      })],
    });
    const [primary, second] = await splitIntoTwoTiles(container);

    await waitFor(() => expect(dock(primary!.element)).toHaveLength(1));
    expect(dock(container)).toHaveLength(1);
    expect(band(primary!)?.getAttribute("data-tool-names")).toBe("agent_spawn");
    await expectUntouched(second!);
  });
});

describe("the skill badge with three tiles", () => {
  it("draws the badge in the tile whose turn loaded the skill, and nowhere else", async () => {
    const { container, emitSkillLoaded } = await renderApp({ hasApiKey: true });
    const [first, middle, third] = await splitIntoThreeTiles(container);
    const badges = (tile: { element: HTMLElement }) =>
      tile.element.querySelectorAll('[data-testid="skill-badge"]');

    // Guard window-wide skill events by owning session to avoid badges in every tile.
    await act(async () => {
      emitSkillLoaded({
        name: "release-notes",
        description: "write the release notes",
        sessionId: `session-${middle!.chatGroupId}`,
      });
    });

    await waitFor(() => expect(badges(middle!)).toHaveLength(1));
    expect(container.querySelectorAll('[data-testid="skill-badge"]')).toHaveLength(1);
    expect(badges(first!)).toHaveLength(0);
    expect(badges(third!)).toHaveLength(0);
  });
});

// With several tiles, session surfaces remain local and unowned news renders once.
describe("three tiles, every kind of surface at once", () => {
  it("puts each surface on exactly one tile, and what no tile owns in the window", async () => {
    const { container, api, emitApproval, emitAskUserQuestion, emitSkillLoaded, emitRoutineFired } =
      await renderApp({ hasApiKey: true, currentSession: SUGGESTIONS_SESSION_ID });
    const [first, middle, third] = await splitIntoThreeTiles(container);
    const onHit = permissionSubscription(api, "onUserApprovalHit");
    const middleSession = `session-${middle!.chatGroupId}`;
    const count = (root: HTMLElement, testId: string) =>
      root.querySelectorAll(`[data-testid="${testId}"]`).length;

    await act(async () => {
      emitApproval({
        id: "req-acceptance",
        category: "tool",
        toolName: "write_file",
        toolCategory: "write",
        args: { path: "/tmp/out.md" },
        reason: "write the summary",
        createdAt: Date.now(),
        requireExplicit: true,
        sessionId: middleSession,
        nonce: "nonce-acceptance",
        hmac: "hmac-acceptance",
      });
      emitSkillLoaded({
        name: "release-notes",
        description: "write the release notes",
        sessionId: middleSession,
      });
      emitRoutineFired({
        id: "schedule-daily",
        trigger: "schedule",
        firedAt: new Date().toISOString(),
        title: "Daily schedule",
        summary: "daily summary",
      });
      (onHit.mock.calls[0]?.[0] as (payload: {
        toolName: string;
        scope: "session" | "persistent";
        verdictAtApproval: "low" | "medium" | "high";
      }) => void)({ toolName: "fs_write", scope: "persistent", verdictAtApproval: "low" });
    });

    await waitFor(() => expect(count(container, "approval-dock")).toBe(1));
    await waitFor(() => expect(count(container, "user-approval-hit-toast")).toBe(1));
    expect(count(container, "skill-badge")).toBe(1);
    expect(count(container, "overlay-card-region")).toBe(1);

    await focusTile(third!);

    expect(count(middle!.element, "approval-dock")).toBe(1);
    expect(count(middle!.element, "skill-badge")).toBe(1);
    // Assert the Suggestions tile explicitly; a count of one alone cannot prove correct routing.
    await waitFor(() => expect(count(first!.element, "overlay-card-region")).toBe(1));
    expect(count(third!.element, "overlay-card-region")).toBe(0);
    expect(count(middle!.element, "overlay-card-region")).toBe(0);
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();

    await act(async () => {
      emitAskUserQuestion({
        id: "ask-acceptance",
        sessionId: middleSession,
        questions: [{ question: "어느 쪽으로 갈까요?", choices: ["A", "B"] }],
      });
    });
    await waitFor(() => expect(count(middle!.element, "question-overlay")).toBe(1));
    expect(count(container, "question-overlay")).toBe(1);

    await submitChatMessage(first!.element, "첫 타일 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await focusTile(third!);
    await submitChatMessage(third!.element, "셋째 타일 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));

    const suggestions = first!;
    for (const tile of [first!, third!]) {
      expect(tile.element.querySelectorAll(BLOCKING_SURFACE_SELECTOR)).toHaveLength(0);
      expect(count(tile.element, "skill-badge")).toBe(0);
      expect(count(tile.element, "user-approval-hit-toast")).toBe(0);
      expect(count(tile.element, "overlay-card-region")).toBe(tile === suggestions ? 1 : 0);
    }
    expect(count(suggestions.element, "overlay-card-region")).toBe(1);
    expect(count(container, "overlay-card-region")).toBe(1);
  });
});

// Running loops cannot swap sessions because they own the history being written.
// Open another conversation in its own group without disabling sidebar navigation.
describe("opening a conversation while another is mid-turn", () => {
  const OTHER_SESSION = "sess-other";
  const withOtherSession = {
    hasApiKey: true,
    sessions: [
      { id: MOCK_DEFAULT_SESSION_ID, title: "지금 답하는 중", modifiedAt: new Date(2, 0, 2).toISOString() },
      { id: OTHER_SESSION, title: "다른 대화", modifiedAt: new Date(2, 0, 1).toISOString() },
    ],
  };

  const sessionRow = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-testid="sidebar-session-${id}"]`) as HTMLButtonElement | null;

  // Expand the collapsed sidebar rail to exercise session navigation.
  const expandSidebar = async (container: HTMLElement) => {
    const toggle = container.querySelector('[data-testid="sidebar-collapse-toggle"]') as HTMLButtonElement | null;
    if (!toggle || toggle.getAttribute("aria-pressed") === "true") return;
    await act(async () => { fireEvent.click(toggle); });
  };

  const rowFor = (container: HTMLElement, id: string) => waitFor(() => {
    const found = sessionRow(container, id);
    if (!found) throw new Error(`sidebar row for ${id} not rendered`);
    return found;
  });


  it("a narrow canvas adopts the conversation without splitting the canvas", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, releasedGroupIds } = await renderApp({ ...withOtherSession, shellWidth: 600, canvasWidth: 600 });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    await expandSidebar(container);

    const row = await rowFor(container, OTHER_SESSION);
    // One streaming tile must not disable other conversation rows.
    expect(row.disabled).toBe(false);
    await act(async () => { fireEvent.click(row); });

    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith(OTHER_SESSION));
    // On a narrow canvas, adopting another group keeps a single focused tile without rearranging the canvas.
    const tiles = collectTiles(container);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.chatGroupId).not.toBe(MAIN_CHAT_GROUP_ID);
    // Hide displaced conversations without unmounting so streams and running-state indicators survive.
    expect(mountedTileIds(container)).toContain(MAIN_CHAT_GROUP_ID);
    expect(releasedGroupIds()).toEqual([]);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  // Picking a conversation never asked for a split, so even a wide canvas shows the adopted tile alone.
  it("a wide canvas opens the adopted conversation on its own, not as a split", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp(withOtherSession);
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });

    await waitFor(() => expect(collectTiles(container).map((tile) => tile.chatGroupId)).not.toContain(MAIN_CHAT_GROUP_ID));
    expect(collectTiles(container)).toHaveLength(1);
    expect(mountedTileIds(container)).toContain(MAIN_CHAT_GROUP_ID);
    // Assert the adopted tile holds the requested conversation, not merely that a tile appeared.
    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith(OTHER_SESSION));
    await waitFor(() => expect(api.chatSessionHistory).toHaveBeenCalledWith(OTHER_SESSION));

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("stays reachable from a view that is not the conversation surface", async () => {
    // A non-chat view must not disable navigation back to the streaming conversation.
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp(withOtherSession);
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    const own = await rowFor(container, MOCK_DEFAULT_SESSION_ID);
    expect(own.getAttribute("aria-current")).toBe("page");

    const settings = container.querySelector('[data-testid="sidebar-settings"]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(settings); });
    await waitFor(() => {
      expect(sessionRow(container, MOCK_DEFAULT_SESSION_ID)!.getAttribute("aria-current")).toBeNull();
    });

    const offSurface = await rowFor(container, MOCK_DEFAULT_SESSION_ID);
    const other = await rowFor(container, OTHER_SESSION);
    expect(offSurface.disabled).toBe(false);
    expect(other.disabled).toBe(false);

    await act(async () => { fireEvent.click(offSurface); });
    await waitFor(() => {
      expect(sessionRow(container, MOCK_DEFAULT_SESSION_ID)!.getAttribute("aria-current")).toBe("page");
    });

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("refuses out loud when every other conversation is busy, and never evicts the primary", async () => {
    const { container, api, releasedGroupIds } = await renderApp(withOtherSession);
    const pending: Array<{ resolve: (value: { ok: true }) => void }> = [];
    api.chatSend.mockImplementation(async () => {
      const gate = deferred<{ ok: true }>();
      pending.push(gate);
      return gate.promise;
    });

    const tiles = await splitIntoNTiles(container, MAX_CHAT_GROUPS);
    expect(tiles).toHaveLength(MAX_CHAT_GROUPS);
    for (const [index, tile] of tiles.entries()) {
      await focusTile(tile);
      await submitChatMessage(tile.element, `${index + 1}번째`);
    }
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(MAX_CHAT_GROUPS));

    const before = mountedTileIds(container);
    expect(before).toHaveLength(MAX_CHAT_GROUPS);
    api.chatSessionResume.mockClear();

    await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });

    // Making room must not release a busy loop or clear its persisted active session.
    expect(releasedGroupIds()).toEqual([]);
    expect(mountedTileIds(container)).toEqual(before);
    expect(api.chatSessionResume).not.toHaveBeenCalled();
    await waitFor(() => expect(container.textContent).toContain("비워 둘 수 있는 대화가 없습니다"));

    await act(async () => {
      for (const gate of pending) gate.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("New Chat while a turn runs starts the conversation in its own tile, the busy one kept out of view (#2348)", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, releasedGroupIds } = await renderApp(withOtherSession);
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    // A busy tile must not disable the window's new-conversation action.
    const newChat = container.querySelector('[data-testid="sidebar-new-chat"]') as HTMLButtonElement;
    expect(newChat.disabled).toBe(false);
    await act(async () => { fireEvent.click(newChat); });

    // Create a separate group without releasing the busy conversation or splitting the canvas.
    await waitFor(() => expect(collectTiles(container).map((tile) => tile.chatGroupId)).not.toContain(MAIN_CHAT_GROUP_ID));
    expect(collectTiles(container)).toHaveLength(1);
    expect(mountedTileIds(container)).toContain(MAIN_CHAT_GROUP_ID);
    expect(releasedGroupIds()).toEqual([]);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("New Chat at the ceiling with every tile busy refuses out loud instead of going dead (#2348)", async () => {
    const { container, api, releasedGroupIds } = await renderApp(withOtherSession);
    const pending: Array<{ resolve: (value: { ok: true }) => void }> = [];
    api.chatSend.mockImplementation(async () => {
      const gate = deferred<{ ok: true }>();
      pending.push(gate);
      return gate.promise;
    });
    const tiles = await splitIntoNTiles(container, MAX_CHAT_GROUPS);
    for (const [index, tile] of tiles.entries()) {
      await focusTile(tile);
      await submitChatMessage(tile.element, `${index + 1}번째`);
    }
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(MAX_CHAT_GROUPS));
    const before = mountedTileIds(container);

    const newChat = container.querySelector('[data-testid="sidebar-new-chat"]') as HTMLButtonElement;
    expect(newChat.disabled).toBe(false);
    await act(async () => { fireEvent.click(newChat); });

    expect(releasedGroupIds()).toEqual([]);
    expect(mountedTileIds(container)).toEqual(before);
    await waitFor(() => expect(container.textContent).toContain("비워 둘 수 있는 대화가 없습니다"));

    await act(async () => {
      for (const gate of pending) gate.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  describe("New Chat during a turn starts under the project it was asked for (#2348)", () => {
    const projectWindow = {
      hasApiKey: true,
      nativeContextMenu: true,
      workspaceRoots: [
        { path: "/ws", isDefault: true },
        { path: "/proj-a", isDefault: false },
        { path: "/proj-b", isDefault: false },
      ],
      sessions: [{
        id: MOCK_DEFAULT_SESSION_ID, title: "프로젝트 A 대화", modifiedAt: new Date(2, 0, 2).toISOString(),
        projectRoot: "/proj-a", projectName: "proj-a",
      }],
      history: {
        sessionId: MOCK_DEFAULT_SESSION_ID,
        projectRoot: "/proj-a",
        projectName: "proj-a",
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
      },
    };

    async function busyInProjectA() {
      const rendered = await renderApp(projectWindow as never);
      // New groups start with empty loops rather than inheriting primary history.
      const groupImpl = rendered.api.chatGroup.getMockImplementation()!;
      rendered.api.chatGroup.mockImplementation((id: string) => {
        const made = groupImpl(id);
        if (id !== MAIN_CHAT_GROUP_ID) {
          made.chatGetHistory.mockImplementation(async () => ({ sessionId: `session-${id}`, messages: [] }));
        }
        return made;
      });
      await waitFor(() => expect(rendered.container.querySelector('[data-testid="sidebar-project-proj-b"]')).not.toBeNull());
      const pendingSend = deferred<{ ok: true }>();
      rendered.api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
      await submitChatMessage(rendered.container, "아직 답하는 중");
      await waitFor(() => expect(rendered.api.chatSend).toHaveBeenCalled());
      rendered.api.chatNew.mockClear();
      return { ...rendered, pendingSend };
    }

    const lastChatNewRoot = (api: MockAveApi) =>
      (api.chatNew.mock.calls.at(-1)?.[0] as { projectRoot?: string } | undefined)?.projectRoot ?? "(unscoped)";

    // Wait on the adopted tile's actual project so mismatches report the observed value.
    async function expectAdoptedTileProject(
      rendered: Awaited<ReturnType<typeof busyInProjectA>>,
      expected: string,
    ) {
      await waitFor(() => expect(collectTiles(rendered.container).map((tile) => tile.chatGroupId)).not.toContain(MAIN_CHAT_GROUP_ID));
      await waitFor(() => expect(lastChatNewRoot(rendered.api)).toBe(expected));
      await act(async () => {
        rendered.pendingSend.resolve({ ok: true });
        await rendered.pendingSend.promise;
      });
    }

    const railNewChat = (container: HTMLElement) =>
      container.querySelector('[data-testid="sidebar-new-chat"]') as HTMLButtonElement;
    const folderRow = (container: HTMLElement) =>
      container.querySelector('[data-testid="sidebar-project-proj-b"]') as HTMLButtonElement;

    it("New Chat stays in the busy conversation's project", async () => {
      const rendered = await busyInProjectA();
      await act(async () => { fireEvent.click(railNewChat(rendered.container)); });
      await expectAdoptedTileProject(rendered, "/proj-a");
    });

    it("a folder row starts the conversation in that folder", async () => {
      const rendered = await busyInProjectA();
      await act(async () => { fireEvent.click(folderRow(rendered.container)); });
      await expectAdoptedTileProject(rendered, "/proj-b");
    });

    it("the folder menu's New Chat starts the conversation in that folder", async () => {
      const rendered = await busyInProjectA();
      await act(async () => { fireEvent.contextMenu(folderRow(rendered.container)); });
      await act(async () => { rendered.chooseNativeMenuCommand("project.new-chat"); });
      await expectAdoptedTileProject(rendered, "/proj-b");
    });

    it("a chatNew main refuses leaves the window on the project it was on", async () => {
      const rendered = await busyInProjectA();
      rendered.api.chatNew.mockResolvedValueOnce({ ok: false, error: "project-not-allowed" } as never);
      await act(async () => { fireEvent.click(folderRow(rendered.container)); });
      await expectAdoptedTileProject(rendered, "/proj-b");
      await waitFor(() => expect(rendered.container.textContent).toContain("허용되지 않은 프로젝트입니다."));
      // A refused adoption must not seed the project of the next new conversation.
      rendered.api.chatNew.mockClear();
      await act(async () => { fireEvent.click(railNewChat(rendered.container)); });
      await waitFor(() => expect(lastChatNewRoot(rendered.api)).toBe("/proj-a"));
    });

    it("a New Chat refused at the ceiling leaves the window on the project it was on", async () => {
      const rendered = await renderApp(projectWindow as never);
      const pending: Array<{ resolve: (value: { ok: true }) => void }> = [];
      rendered.api.chatSend.mockImplementation(async () => {
        const gate = deferred<{ ok: true }>();
        pending.push(gate);
        return gate.promise;
      });
      const tiles = await splitIntoNTiles(rendered.container, MAX_CHAT_GROUPS);
      for (const [index, tile] of tiles.entries()) {
        await focusTile(tile);
        await submitChatMessage(tile.element, `${index + 1}번째`);
      }
      await waitFor(() => expect(rendered.api.chatSend).toHaveBeenCalledTimes(MAX_CHAT_GROUPS));
      await waitFor(() => expect(folderRow(rendered.container)).not.toBeNull());

      await act(async () => { fireEvent.click(folderRow(rendered.container)); });
      await waitFor(() => expect(rendered.container.textContent).toContain("비워 둘 수 있는 대화가 없습니다"));
      expect(collectTiles(rendered.container)).toHaveLength(MAX_CHAT_GROUPS);

      await act(async () => {
        for (const gate of pending) gate.resolve({ ok: true });
        await Promise.resolve();
      });
      rendered.api.chatSend.mockReset();
      rendered.api.chatNew.mockClear();
      await act(async () => { fireEvent.click(railNewChat(rendered.container)); });
      await waitFor(() => expect(lastChatNewRoot(rendered.api)).toBe("/proj-a"));
    });

    it("an idle New Chat main refuses keeps the conversation, the project and says why", async () => {
      const rendered = await renderApp(projectWindow as never);
      await waitFor(() => expect(folderRow(rendered.container)).not.toBeNull());
      await waitFor(() => expect(rendered.container.textContent).toContain("hello"));
      rendered.api.chatNew.mockResolvedValueOnce({ ok: false, error: "project-not-allowed" } as never);

      await act(async () => { fireEvent.click(folderRow(rendered.container)); });
      await waitFor(() => expect(rendered.container.textContent).toContain("허용되지 않은 프로젝트입니다."));
      expect(rendered.container.textContent).toContain("hello");
      rendered.api.chatNew.mockClear();
      await act(async () => { fireEvent.click(railNewChat(rendered.container)); });
      await waitFor(() => expect(lastChatNewRoot(rendered.api)).toBe("/proj-a"));
    });
  });

  it("deleting a conversation another tile holds resets THAT tile, not the busy focused one (#2348)", async () => {
    const OTHER_GROUP = "group-2";
    const rendered = await renderApp({
      hasApiKey: true,
      nativeContextMenu: true,
      sessions: [
        { id: MOCK_DEFAULT_SESSION_ID, title: "지금 답하는 중", modifiedAt: new Date(2, 0, 2).toISOString() },
        { id: `session-${OTHER_GROUP}`, title: "옆 타일 대화", modifiedAt: new Date(2, 0, 1).toISOString() },
      ],
    });
    const { api, container } = rendered;
    const groupImpl = api.chatGroup.getMockImplementation()!;
    const groupChatNew = vi.fn(async () => ({ ok: true }));
    api.chatGroup.mockImplementation((id: string) => {
      const made = groupImpl(id) as ReturnType<typeof groupImpl> & { chatNew?: unknown };
      if (id === OTHER_GROUP) made.chatNew = groupChatNew;
      return made;
    });
    (api as unknown as { chatSessionDelete: unknown }).chatSessionDelete =
      vi.fn(async () => ({ ok: true, wasLoaded: true }));

    const tiles = await splitIntoTwoTiles(container);
    expect(tiles.map((tile) => tile.chatGroupId)).toEqual(expect.arrayContaining([MAIN_CHAT_GROUP_ID, OTHER_GROUP]));
    const mainTile = tiles.find((tile) => tile.chatGroupId === MAIN_CHAT_GROUP_ID)!;
    await focusTile(mainTile);
    const pendingSend = deferred<{ ok: true }>();
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitChatMessage(mainTile.element, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    api.chatNew.mockClear();

    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(`[data-testid="sidebar-session-session-${OTHER_GROUP}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => { fireEvent.contextMenu(row); });
    await act(async () => { rendered.chooseNativeMenuCommand("conversation.delete"); });

    await waitFor(() => expect(groupChatNew).toHaveBeenCalledTimes(1));
    expect(api.chatNew).not.toHaveBeenCalled();
    expect(collectTiles(container)).toHaveLength(2);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("a deleted conversation whose folder main now refuses restarts its tile unscoped, and says why (#2348)", async () => {
    const OTHER_GROUP = "group-2";
    const rendered = await renderApp({
      hasApiKey: true,
      nativeContextMenu: true,
      workspaceRoots: [{ path: "/ws", isDefault: true }, { path: "/proj-a", isDefault: false }],
      sessions: [
        { id: MOCK_DEFAULT_SESSION_ID, title: "주 대화", modifiedAt: new Date(2, 0, 2).toISOString() },
        // Omit the listed folder to show the row; use loop history as the tile's project authority.
        { id: `session-${OTHER_GROUP}`, title: "옆 타일 대화", modifiedAt: new Date(2, 0, 1).toISOString() },
      ],
      history: {
        sessionId: MOCK_DEFAULT_SESSION_ID,
        projectRoot: "/proj-a",
        projectName: "proj-a",
        messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
      },
    } as never);
    const { api, container } = rendered;
    const groupImpl = api.chatGroup.getMockImplementation()!;
    const groupChatNew = vi.fn(async (_project?: { projectRoot?: string }) => ({ ok: true }) as { ok: boolean; error?: string });
    groupChatNew.mockResolvedValueOnce({ ok: false, error: "project-not-allowed" });
    api.chatGroup.mockImplementation((id: string) => {
      const made = groupImpl(id) as ReturnType<typeof groupImpl> & { chatNew?: unknown };
      if (id === OTHER_GROUP) made.chatNew = groupChatNew;
      return made;
    });
    (api as unknown as { chatSessionDelete: unknown }).chatSessionDelete =
      vi.fn(async () => ({ ok: true, wasLoaded: true }));

    await splitIntoTwoTiles(container);
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(`[data-testid="sidebar-session-session-${OTHER_GROUP}"]`);
      expect(found).not.toBeNull();
      return found!;
    });
    await act(async () => { fireEvent.contextMenu(row); });
    await act(async () => { rendered.chooseNativeMenuCommand("conversation.delete"); });

    // If the original project is refused, report it and start unscoped rather than retain a deleted session.
    await waitFor(() => expect(groupChatNew).toHaveBeenCalledTimes(2));
    expect(groupChatNew.mock.calls[0]?.[0]).toMatchObject({ projectRoot: "/proj-a" });
    expect(groupChatNew.mock.calls[1]?.[0]).toBeUndefined();
    await waitFor(() => expect(container.textContent).toContain("허용되지 않은 프로젝트입니다."));
  });

  it("clicking the streaming conversation's own row is navigation, not a load", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp(withOtherSession);
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    api.chatSessionResume.mockClear();

    const row = await rowFor(container, MOCK_DEFAULT_SESSION_ID);
    expect(row.disabled).toBe(false);
    await act(async () => { fireEvent.click(row); });

    // Already-held conversations need no host reload or adoption; navigation must work from non-chat views.
    expect(api.chatSessionResume).not.toHaveBeenCalled();
    expect(collectTiles(container)).toHaveLength(1);
    expect(collectTiles(container)[0]!.chatGroupId).toBe(MAIN_CHAT_GROUP_ID);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("keeps a hidden tile's card with it, undrawn, and marks its sidebar row", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitOverlayShow } = await renderApp({ ...withOtherSession, shellWidth: 600, canvasWidth: 600 });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    await expandSidebar(container);
    await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });
    await waitFor(() => expect(mountedTileIds(container).length).toBe(2));

    // Hidden conversations cannot draw approval; retain a reachable route to the parked request.
    await act(async () => {
      emitOverlayShow({
        id: "app:invoices:hidden",
        source: { kind: "app", serverId: "invoices", eventId: "hidden" },
        originSessionId: MOCK_DEFAULT_SESSION_ID,
        title: "invoices",
        summary: "숨은 타일의 카드",
        running: false,
        pendingPrompt: '<app-message source="app:invoices">\n숨은 타일의 카드\n</app-message>',
        createdAt: new Date().toISOString(),
      });
    });

    await waitFor(() => {
      expect(container.querySelector(`[data-testid="sidebar-pending-answer-${MOCK_DEFAULT_SESSION_ID}"]`)).not.toBeNull();
    });
    expect(container.querySelector('[data-overlay-surface="window"]')).toBeNull();
    expect(container.textContent).not.toContain("숨은 타일의 카드");
    const hiddenTile = container.querySelector<HTMLElement>(
      `[data-testid="pane-cell:${MAIN_CHAT_GROUP_ID}"]`,
    );
    expect(hiddenTile?.getAttribute("data-hidden")).toBe("true");

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("keeps a hidden tile's question parked in it, and marks its sidebar row", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitAskUserQuestion } = await renderApp({ ...withOtherSession, shellWidth: 600, canvasWidth: 600 });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());

    await act(async () => {
      emitAskUserQuestion({
        id: "ask-before-hide",
        sessionId: MOCK_DEFAULT_SESSION_ID,
        questions: [{ question: "어느 형식으로 정리할까요?", choices: ["표", "목록"] }],
        createdAt: Date.now(),
      });
    });
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(1);
    });

    await expandSidebar(container);
    await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });
    await waitFor(() => expect(mountedTileIds(container).length).toBe(2));

    const hiddenTile = container.querySelector<HTMLElement>(
      `[data-testid="pane-cell:${MAIN_CHAT_GROUP_ID}"]`,
    )!;
    expect(hiddenTile.getAttribute("data-hidden")).toBe("true");
    // Hidden questions retain their origin and mark the navigation row that restores them.
    await waitFor(() => {
      expect(container.querySelector(`[data-testid="sidebar-pending-answer-${MOCK_DEFAULT_SESSION_ID}"]`)).not.toBeNull();
    });
    expect(container.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(0);
    expect(hiddenTile.querySelectorAll('[data-testid="question-overlay"]')).toHaveLength(0);
    expect(container.querySelector('[data-testid="window-approval-scope"]')).toBeNull();

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("keeps a hidden tile's approval parked in it, and marks its sidebar row", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitApproval } = await renderApp({ ...withOtherSession, shellWidth: 600, canvasWidth: 600 });
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await submitChatMessage(container, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    await expandSidebar(container);
    await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });
    await waitFor(() => expect(mountedTileIds(container).length).toBe(2));

    // Keep parked approvals with hidden running turns and expose their waiting state in navigation.
    await act(async () => {
      emitApproval({
        id: "req-hidden-tile",
        category: "tool",
        toolName: "read_file",
        toolCategory: "read",
        args: { path: "/tmp/notes.md" },
        reason: "read the notes",
        createdAt: Date.now(),
        requireExplicit: false,
        nonce: "nonce-hidden-tile",
        hmac: "hmac-hidden-tile",
        sessionId: MOCK_DEFAULT_SESSION_ID,
      });
    });

    const hiddenTile = container.querySelector<HTMLElement>(
      `[data-testid="pane-cell:${MAIN_CHAT_GROUP_ID}"]`,
    )!;
    expect(hiddenTile.getAttribute("data-hidden")).toBe("true");
    await waitFor(() => {
      expect(container.querySelector(`[data-testid="sidebar-pending-answer-${MOCK_DEFAULT_SESSION_ID}"]`)).not.toBeNull();
    });
    expect(container.querySelectorAll('[data-testid="approval-dock"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="approval-lane-card"]')).toHaveLength(0);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("a conversation dropped on a mid-turn tile's centre gets its own group", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api } = await renderApp(withOtherSession);
    const [, second] = await splitIntoTwoTiles(container);
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);

    await focusTile(second!);
    await submitChatMessage(second!.element, "아직 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalled());
    api.chatSessionResume.mockClear();

    // Center drops cannot replace the session under a running loop.
    const frame = second!.element.querySelector('[data-testid="pane"]')!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    // Set drag coordinates explicitly because the DOM test environment drops them.
    const drop = createEvent.drop(frame, {
      dataTransfer: {
        types: [CHAT_SESSION_DRAG_TYPE], getData: () => OTHER_SESSION, dropEffect: "none", files: [],
      },
    });
    Object.defineProperty(drop, "clientX", { value: 400 });
    Object.defineProperty(drop, "clientY", { value: 300 });
    await act(async () => { fireEvent(frame, drop); });

    await waitFor(() => expect(mountedTileIds(container)).toHaveLength(3));
    await waitFor(() => expect(api.chatSessionResume).toHaveBeenCalledWith(OTHER_SESSION));

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await pendingSend.promise;
    });
  });

  it("releases the loop of the group it set aside, and says so", async () => {
    const { container, api, releasedGroupIds } = await renderApp(withOtherSession);
    const pending: Array<{ resolve: (value: { ok: true }) => void }> = [];
    api.chatSend.mockImplementation(async () => {
      const gate = deferred<{ ok: true }>();
      pending.push(gate);
      return gate.promise;
    });

    const tiles = await splitIntoNTiles(container, MAX_CHAT_GROUPS);
    await focusTile(tiles[1]!);
    await submitChatMessage(tiles[1]!.element, "옆 타일");
    await focusTile(tiles[0]!);
    await submitChatMessage(tiles[0]!.element, "여기도 답하는 중");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));

    await act(async () => { fireEvent.click(await rowFor(container, OTHER_SESSION)); });

    const released = releasedGroupIds();
    expect(released).toHaveLength(1);
    // Make room only by releasing idle tiles, never busy or newly adopted groups.
    expect(released[0]).not.toBe(MAIN_CHAT_GROUP_ID);
    expect(released[0]).not.toBe(tiles[1]!.chatGroupId);
    expect([tiles[2]!.chatGroupId, tiles[3]!.chatGroupId]).toContain(released[0]);
    expect(mountedTileIds(container)).not.toContain(released[0]);
    expect(mountedTileIds(container)).toHaveLength(MAX_CHAT_GROUPS);
    // Surface the cost when navigation must displace an existing tile.
    await waitFor(() => expect(container.textContent).toContain("자리를 만들기 위해"));

    await act(async () => {
      for (const gate of pending) gate.resolve({ ok: true });
      await Promise.resolve();
    });
  });
});

describe("notices with two tiles", () => {
  const toasts = (root: ParentNode) => root.querySelectorAll('[data-testid="status-toast-message"]');
  const strip = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="window-notice-strip"]')!;

  it("draws a window notice once, in the window strip, and in no composer dock", async () => {
    const { container, emitNotificationToast } = await renderApp({ hasApiKey: true });
    await splitIntoTwoTiles(container);

    await act(async () => {
      emitNotificationToast({ kind: "ask-user", title: "질문", body: "창 전체에 한 번", contextRef: { questionId: "q-1" } });
    });

    // Window notifications render once regardless of tile count.
    await waitFor(() => expect(toasts(container)).toHaveLength(1));
    expect(toasts(strip(container))).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="composer-toast-dock"]')).toHaveLength(0);
  });

  it("draws a provider fallback in the tile whose turn swapped, focused or not", async () => {
    const { container, emitChatFallback } = await renderApp({ hasApiKey: true });
    const [first, second] = await splitIntoTwoTiles(container);

    await act(async () => {
      emitChatFallback(first!.chatGroupId, { from: "primary-provider", to: "standby-provider" });
    });

    await waitFor(() => expect(toasts(first!.element)).toHaveLength(1));
    expect(toasts(second!.element)).toHaveLength(0);
    expect(toasts(strip(container))).toHaveLength(0);
    expect(toasts(container)).toHaveLength(1);

    // Notices occupy their own flow row so they cannot cover the selector strip.
    const toastRow = first!.element.querySelector<HTMLElement>('[data-testid="composer-toast-dock"]')!;
    const selectorSlot = first!.element.querySelector<HTMLElement>('[data-testid="composer-project-selector-slot"]')!;
    expect(selectorSlot).not.toBeNull();
    expect(toastRow.className).not.toMatch(/\b(absolute|fixed)\b/);
    expect(toastRow.contains(selectorSlot)).toBe(false);
    expect(toastRow.nextElementSibling?.contains(selectorSlot)).toBe(true);
    expect(toastRow.parentElement!.className).toMatch(/\bflex-col\b/);
  });

  it("keeps the window strip in flow above the panes, never floating over a pane's lane", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await splitIntoTwoTiles(container);
    const listener = api.onMarketplaceAnnouncements.mock.calls[0]?.[0] as
      | ((items: MarketplaceAnnouncement[]) => void)
      | undefined;
    expect(listener).toBeDefined();
    await act(async () => {
      listener!([{
        id: 1, title: "Announcement", body: "Shown to the window", level: "info",
        createdAt: "2026-09-03T00:00:00Z", startsAt: null, endsAt: null, actions: [],
      }]);
    });

    const notices = strip(container);
    await waitFor(() => expect(notices.querySelector('[data-testid="marketplace-announcement-banner"]')).not.toBeNull());
    // Keep window notices before the route canvas in flow, clear of pane floating lanes.
    expect(notices.className).not.toMatch(/\b(absolute|fixed)\b/);
    const canvas = container.querySelector<HTMLElement>(`[data-testid="${TEST_IDS.routeCanvas}"]`)!;
    expect(notices.parentElement).toBe(canvas.parentElement);
    expect(notices.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});
