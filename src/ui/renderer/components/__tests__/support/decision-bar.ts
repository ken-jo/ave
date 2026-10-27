import { fireEvent, screen, within } from "@testing-library/react";
import type { ApprovalCardChoice } from "../../permissions/approval-decision.js";

type MenuChoice = Exclude<ApprovalCardChoice, "allow-once">;

/** Opens the dropdown that holds `choice` (the deny one for deny choices, else the allow one) inside `scope`, and returns its item. */
export function openDecisionMenu(choice: MenuChoice, scope: HTMLElement = document.body): HTMLElement {
  const trigger = within(scope).getByTestId(choice.startsWith("deny") ? "approval-deny-menu" : "approval-allow-menu");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  return screen.getByTestId(`approval-choice-${choice}`);
}

/** Selects `choice` from its dropdown, as a person would before pressing the button beside it. */
export function selectDecision(choice: MenuChoice, scope: HTMLElement = document.body): void {
  const item = openDecisionMenu(choice, scope);
  fireEvent.keyDown(item, { key: "Enter" });
}
