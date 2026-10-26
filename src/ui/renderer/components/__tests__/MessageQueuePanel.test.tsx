// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageQueuePanel } from "../MessageQueuePanel.js";
import { MessageQueueStore } from "../../state/message-queue-store.js";

function renderQueuePanel() {
  const store = new MessageQueueStore();
  store.add("first queued message");
  store.add("second queued message");
  const onSendNow = vi.fn();
  render(<MessageQueuePanel store={store} onSendNow={onSendNow} heldByApproval={false} />);
  return { store, onSendNow };
}

describe("MessageQueuePanel keyboard navigation", () => {
  it("focuses the first queue row when the expanded panel appears", async () => {
    renderQueuePanel();
    const rows = screen.getAllByTestId("message-queue-row");

    await waitFor(() => {
      expect(document.activeElement).toBe(rows[0]);
    });
  });

  it("moves focus between queue rows with ArrowUp and ArrowDown", () => {
    renderQueuePanel();
    const rows = screen.getAllByTestId("message-queue-row");

    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1], { key: "ArrowUp" });
    expect(document.activeElement).toBe(rows[0]);
  });

  it("toggles the focused queue row with Space", async () => {
    renderQueuePanel();
    const row = screen.getAllByTestId("message-queue-row")[0];

    row.focus();
    fireEvent.keyDown(row, { key: " " });

    await waitFor(() => {
      expect(screen.getAllByTestId("message-queue-row")[0]).toHaveAttribute("data-selected", "true");
    });
  });

  it("reorders with labelled buttons and keeps focus on the moved row", async () => {
    const { store } = renderQueuePanel();
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByTestId("message-queue-row")[0]));
    const firstRow = screen.getAllByTestId("message-queue-row")[0];
    const up = screen.getAllByTestId("message-queue-row-move-up");
    const down = screen.getAllByTestId("message-queue-row-move-down");
    expect(up[0]).toBeDisabled();
    expect(down[1]).toBeDisabled();
    expect(down[0].getAttribute("aria-label")).toBeTruthy();

    fireEvent.click(down[0]);

    expect(store.getItems().map((item) => item.text)).toEqual(["second queued message", "first queued message"]);
    expect(document.activeElement).toBe(firstRow);
    expect(firstRow).toHaveAttribute("aria-posinset", "2");
    expect(screen.getByRole("status")).toHaveTextContent("first queued message");
  });

  it("reorders with Alt and arrow keys while ordinary arrows only navigate", async () => {
    const { store } = renderQueuePanel();
    const rows = screen.getAllByTestId("message-queue-row");
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));

    fireEvent.keyDown(rows[0], { key: "ArrowDown", altKey: true });

    expect(store.getItems().map((item) => item.text)).toEqual(["second queued message", "first queued message"]);
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0], { key: "ArrowUp", altKey: true });
    expect(store.getItems().map((item) => item.text)).toEqual(["first queued message", "second queued message"]);
  });

  it("keeps delivering rows fixed and does not reorder while editing", () => {
    const { store } = renderQueuePanel();
    act(() => store.markHandedOff([store.getItems()[0].id], "first queued message"));
    expect(screen.getAllByTestId("message-queue-row-move-up")).toHaveLength(1);
    expect(screen.getByTestId("message-queue-row-move-up")).toBeDisabled();
    fireEvent.click(screen.getByTestId("message-queue-row-edit-button"));
    const input = screen.getByTestId("message-queue-row-edit");
    fireEvent.keyDown(input, { key: "ArrowUp", altKey: true });
    expect(store.getItems().map((item) => item.text)).toEqual(["first queued message", "second queued message"]);
  });
});

describe("MessageQueuePanel colour contract", () => {
  // Accent is a light surface tint; queue text and selected borders need foreground tokens.
  it("never paints a foreground or border with the accent surface token", async () => {
    const { store } = renderQueuePanel();
    const first = store.getItems()[0];
    expect(first).toBeDefined();
    store.toggleSelect(first!.id);
    await waitFor(() => {
      expect(screen.getAllByTestId("message-queue-row")[0]).toHaveAttribute("data-selected", "true");
    });

    const panel = screen.getByTestId("message-queue-panel");
    for (const el of [panel, ...panel.querySelectorAll<HTMLElement>("*")]) {
      const classes = typeof el.className === "string" ? el.className : "";
      expect(classes).not.toMatch(/(?:^|\s)text-accent(?:\/|\s|$)/);
      expect(classes).not.toMatch(/(?:^|\s)border-accent(?:\/|\s|$)/);
      expect(classes).not.toMatch(/(?:^|\s)bg-accent(?:\/|\s|$)/);
    }
  });

  it("keeps the per-row inject action rendered, labelled and wired", () => {
    const { onSendNow } = renderQueuePanel();
    const injectButtons = screen.getAllByTestId("message-queue-row-send-now-button");
    expect(injectButtons).toHaveLength(2);
    expect(injectButtons[0]!.getAttribute("aria-label")).toBeTruthy();

    fireEvent.click(injectButtons[0]!);
    expect(onSendNow).toHaveBeenCalledTimes(1);
  });
});

describe("MessageQueuePanel guide reservation", () => {
  it("shows progress before acceptance and prevents pointer and keyboard mutation", () => {
    const { store, onSendNow } = renderQueuePanel();
    let reservation!: NonNullable<ReturnType<MessageQueueStore["reservePending"]>>;
    act(() => { reservation = store.reservePending()!; });
    const rows = screen.getAllByTestId("message-queue-row");
    expect(screen.getAllByTestId("message-queue-row-handoff-in-progress")).toHaveLength(2);
    expect(screen.queryByTestId("message-queue-row-handed-off")).toBeNull();
    expect(screen.queryByTestId("message-queue-row-send-now-button")).toBeNull();
    expect(screen.queryByTestId("message-queue-row-move-up")).toBeNull();
    expect(rows[0]).toHaveAttribute("aria-busy", "true");
    fireEvent.keyDown(rows[0], { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(rows[0], { key: "Delete" });
    fireEvent.keyDown(rows[0], { key: " " });
    fireEvent.doubleClick(screen.getAllByTestId("message-queue-row-text")[0]);
    expect(screen.queryByTestId("message-queue-row-edit")).toBeNull();
    expect(store.getItems().map((item) => item.text)).toEqual(["first queued message", "second queued message"]);
    expect(store.hasSelected()).toBe(false);
    expect(onSendNow).not.toHaveBeenCalled();
    act(() => store.settleReservation(reservation.id));
    expect(screen.queryByTestId("message-queue-row-handoff-in-progress")).toBeNull();
    expect(screen.getAllByTestId("message-queue-row-send-now-button")).toHaveLength(2);
  });

  it("keeps a pending neighbour from crossing a reservation and changes the badge only after acceptance", () => {
    const { store } = renderQueuePanel();
    const second = store.takeOne(store.getItems()[1].id)!;
    let reservation!: NonNullable<ReturnType<MessageQueueStore["reservePending"]>>;
    act(() => {
      reservation = store.reservePending()!;
      store.add(second.text);
    });
    expect(screen.getByTestId("message-queue-row-move-up")).toBeDisabled();
    act(() => store.settleReservation(reservation.id, "first queued message"));
    expect(screen.queryByTestId("message-queue-row-handoff-in-progress")).toBeNull();
    expect(screen.getByTestId("message-queue-row-handed-off")).toBeVisible();
  });
});
