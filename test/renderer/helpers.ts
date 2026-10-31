import { createElement, type ReactElement } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import type { MessageQueueStore } from "../../src/ui/renderer/state/message-queue-store.js";
import { SETTINGS_TABS } from "../../src/shared/settings-tabs.js";
import { MOCK_DEFAULT_SETTINGS } from "./mock-ave-api.js";
import type { ToolActivityState } from "../../src/ui/renderer/components/ToolActivity.js";
import { ApprovalSurfaceClaims, type ApprovalSurfaceContextValue } from "../../src/ui/renderer/hooks/use-approval.js";
import { expect, vi } from "vitest";
export { relativeLuminance } from "../contrast-helpers.js";
export { deferred } from "../../src/__tests__/support/deferred.js";

// Supply empty approval context when rendering dock-owning bodies outside the app.
export function approvalSurfaceStub(): ApprovalSurfaceContextValue {
  return {
    queue: [],
    decide: vi.fn(async () => undefined),
    dropSettled: vi.fn(),
    claims: new ApprovalSurfaceClaims(),
    openPermanentDeny: vi.fn(),
    lockedRequestId: null,
    proposal: null,
    reviewerSuggestion: null,
  };
}

export async function submitChatMessage(
  container: HTMLElement,
  text: string,
): Promise<void> {
  const textarea = container.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!textarea) throw new Error("main composer textarea not found");
  await act(async () => {
    fireEvent.change(textarea, { target: { value: text } });
  });
  await act(async () => {
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });
  });
}

export interface RenderedTile {
  chatGroupId: string;
  element: HTMLElement;
}

// Enumerate visible tiles only; hidden conversations stay mounted to retain stream subscriptions.
export function collectTiles(container: HTMLElement): RenderedTile[] {
  const prefix = "pane-cell:";
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`))
    .filter((element) => element.getAttribute("data-hidden") !== "true")
    .map((element) => ({
      chatGroupId: element.getAttribute("data-testid")!.slice(prefix.length),
      element,
    }));
}

export function mountedTileIds(container: HTMLElement): string[] {
  const prefix = "pane-cell:";
  return Array.from(container.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`))
    .map((element) => element.getAttribute("data-testid")!.slice(prefix.length));
}

// Splitting creates a second conversation and moves focus to the new tile.
export async function splitIntoTwoTiles(container: HTMLElement): Promise<RenderedTile[]> {
  return splitWith(container, container, 2);
}

export async function splitIntoThreeTiles(container: HTMLElement): Promise<RenderedTile[]> {
  return splitIntoNTiles(container, 3);
}

export async function splitIntoNTiles(
  container: HTMLElement,
  count: number,
): Promise<RenderedTile[]> {
  let tiles = await splitIntoTwoTiles(container);
  for (let open = 3; open <= count; open += 1) {
    tiles = await splitWith(container, tiles[tiles.length - 1]!.element, open);
  }
  return tiles;
}

async function splitWith(
  container: HTMLElement,
  holder: HTMLElement,
  expectedTiles: number,
): Promise<RenderedTile[]> {
  const split = holder.querySelector<HTMLButtonElement>('[data-testid="pane-split"]');
  if (!split) throw new Error("no pane split control");
  await act(async () => {
    fireEvent.click(split);
  });
  // The split direction menu is portaled; query it from the document.
  const sideBySide = document.querySelector<HTMLButtonElement>('[data-testid="pane-split-row"]');
  if (!sideBySide) throw new Error("no split direction choice");
  await act(async () => {
    fireEvent.click(sideBySide);
  });
  const tiles = collectTiles(container);
  if (tiles.length !== expectedTiles) {
    throw new Error(`expected ${expectedTiles} tiles, got ${tiles.length}`);
  }
  return tiles;
}

// Maximizing unmounts other tiles, exercising approvals whose origin stops being visible.
export async function toggleTileMaximized(tile: RenderedTile): Promise<void> {
  const button = tile.element.querySelector<HTMLButtonElement>('[data-testid="pane-maximize"]');
  if (!button) throw new Error(`tile ${tile.chatGroupId} has no maximize control`);
  await act(async () => {
    fireEvent.click(button);
  });
}

// Simulate overflow because the DOM test environment computes no layout; return an undo function.
export function forceOverflowingSummaries(): () => void {
  const scrollDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
  const clientDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 120 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 40 });
  return () => {
    if (scrollDesc) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollDesc);
    if (clientDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientDesc);
  };
}

export async function focusTile(tile: RenderedTile): Promise<void> {
  const frame = tile.element.querySelector<HTMLElement>('[data-testid="pane"]');
  if (!frame) throw new Error(`tile ${tile.chatGroupId} has no frame`);
  await act(async () => {
    fireEvent.mouseDown(frame);
  });
}

// Enable development and E2E flags to expose the live message queue store.
export function getQueueStore(): MessageQueueStore | undefined {
  return (window as unknown as { __ave_message_queue_store__?: MessageQueueStore })
    .__ave_message_queue_store__;
}

export function clearQueueStoreHandle(): void {
  delete (window as unknown as { __ave_message_queue_store__?: unknown })
    .__ave_message_queue_store__;
}

// Address settings tabs by stable ids and scope away from unrelated tablists.
export function endAnimation(element: Element): void {
  act(() => {
    element.dispatchEvent(new Event("webkitAnimationEnd", { bubbles: true }));
    element.dispatchEvent(new Event("animationend", { bubbles: true }));
  });
}

export function settingsTabTrigger(container: HTMLElement, value: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[role="tab"][id$="-trigger-${value}"]`);
  if (!el) throw new Error(`no settings tab trigger for "${value}"`);
  return el;
}

export function clickSettingsTab(container: HTMLElement, value: string): void {
  const trigger = settingsTabTrigger(container, value);
  fireEvent.mouseDown(trigger, { button: 0 });
  fireEvent.click(trigger);
}

export function activeSettingsTab(container: HTMLElement): string | null {
  for (const value of SETTINGS_TABS) {
    const el = container.querySelector<HTMLElement>(`[role="tab"][id$="-trigger-${value}"]`);
    if (el?.getAttribute("data-state") === "active") return value;
  }
  return null;
}

// Share persisted-location fixtures so restore and visit-history assertions use identical input.
export function settingsWithActiveView(activeView: string, settingsTab?: string) {
  return {
    ...MOCK_DEFAULT_SETTINGS,
    system: {
      closeBehavior: "hide-to-tray",
      activeView,
      ...(settingsTab ? { settingsTab } : {}),
    },
  };
}

export function emptyToolActivity(): ToolActivityState {
  return {
    readFileCount: 0,
    changedFileCount: 0,
    mcpCallCount: 0,
    pluginCallCount: 0,
    toolCallCount: 0,
    fetchedPageCount: 0,
    readFiles: [],
    changedFiles: [],
    pluginCalls: [],
    mcpCalls: [],
    toolCalls: [],
    fetchedPages: [],
  };
}

export function renderWithTooltipProvider(ui: ReactElement) {
  return render(createElement(TooltipProvider, null, ui));
}

export type SidebarNavGroup = "features" | "plugins";

function sidebarGroupMenu(group: SidebarNavGroup): HTMLElement | null {
  return document.querySelector(`[data-testid="sidebar-group-${group}-menu"]`);
}

// Flyout rows are portaled; query the document rather than the render container.
export async function openSidebarGroup(group: SidebarNavGroup): Promise<HTMLElement> {
  const trigger = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>(`[data-testid="sidebar-group-${group}"]`);
    expect(el, `missing sidebar group ${group}`).not.toBeNull();
    return el!;
  });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    await act(async () => {
      fireEvent.click(trigger);
    });
  }
  return await waitFor(() => {
    const menu = sidebarGroupMenu(group);
    expect(menu, `flyout of ${group} did not open`).not.toBeNull();
    return menu!;
  });
}

export async function closeSidebarGroup(group: SidebarNavGroup): Promise<void> {
  const menu = sidebarGroupMenu(group);
  if (!menu) return;
  await act(async () => {
    fireEvent.keyDown(menu, { key: "Escape" });
  });
  await waitFor(() => expect(sidebarGroupMenu(group)).toBeNull());
}

// Modified clicks open a destination in another pane.
export async function clickSidebarNavRow(
  group: SidebarNavGroup,
  rowTestId: string,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
): Promise<void> {
  const menu = await openSidebarGroup(group);
  const row = menu.querySelector<HTMLButtonElement>(`[data-testid="${rowTestId}"]`);
  expect(row, `missing [data-testid="${rowTestId}"] in the ${group} flyout`).not.toBeNull();
  await act(async () => {
    fireEvent.click(row!, modifiers);
  });
  await waitFor(() => expect(sidebarGroupMenu(group)).toBeNull());
}

export async function sidebarNavRowActive(group: SidebarNavGroup, rowTestId: string): Promise<boolean> {
  const menu = await openSidebarGroup(group);
  const active = menu.querySelector(`[data-testid="${rowTestId}"]`)?.getAttribute("aria-current") === "page";
  await closeSidebarGroup(group);
  return active;
}

// Default approval fixtures use the read lane; override identity and grant fields for other cases.
export function approvalRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "req-approval",
    category: "tool",
    toolName: "read_file",
    toolCategory: "read",
    args: { path: "/tmp/notes.md" },
    reason: "read the notes",
    createdAt: Date.now(),
    requireExplicit: false,
    nonce: "nonce-approval",
    hmac: "hmac-approval",
    ...overrides,
  };
}
