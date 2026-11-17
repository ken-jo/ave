// @vitest-environment jsdom
/** The add dialog shows a refusal code from the store as its text, and any other reason as sent. */
import "../../../../../test/renderer/setup.js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkItemCreateDialog } from "../WorkBoardPanel.js";
import { t } from "../../../../i18n/runtime.js";
import type { AveApi } from "../../types.js";

afterEach(() => cleanup());

async function submit(reason: string): Promise<{ error: string; onCreated: () => void; onClose: () => void }> {
  const api = { addWorkBoardItem: vi.fn(async () => ({ status: "invalid" as const, reason })) } as unknown as AveApi;
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(<WorkItemCreateDialog api={api} onClose={onClose} onCreated={onCreated} />);
  fireEvent.change(screen.getByTestId("work-board-create-title"), { target: { value: "Work" } });
  fireEvent.click(screen.getByTestId("work-board-create-submit"));
  return { error: (await screen.findByTestId("work-board-create-error")).textContent ?? "", onCreated, onClose };
}

it("says in words that no item was added while no row id can be issued, and stays open", async () => {
  const { error, onCreated, onClose } = await submit("work-item-ids-unavailable");
  expect(error).toBe(t("reasonCodes.work-item-ids-unavailable"));
  expect(onCreated).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("says in words that item numbers have run out, and stays open", async () => {
  const { error, onCreated, onClose } = await submit("work-item-ids-exhausted");
  expect(error).toBe(t("reasonCodes.work-item-ids-exhausted"));
  expect(onCreated).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it("shows any other refusal as the store sent it", async () => {
  expect((await submit("title exceeds 200 chars")).error).toBe("title exceeds 200 chars");
});
