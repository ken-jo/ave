import { afterEach, expect, it, vi } from "vitest";
import { WORK_BOARD } from "../../src/shared/ipc-channels.js";
import { WORK_BOARD_DECISION_ATTRIBUTE, workBoardDecisionKey } from "../../src/shared/work-board-decision-intent.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]) => true) }));
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));

const input = { runId: "run-a", stageId: "review", attempt: 1, resultHash: "a".repeat(64), decision: "approve" };
const key = workBoardDecisionKey(WORK_BOARD.decideStage, 7, input);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("does not send a receipt for a synthetic click or an unrelated script call during activation", async () => {
  vi.stubGlobal("navigator", { userActivation: { isActive: true } });
  const { invokeWorkBoardDecision } = await import("../../src/preload/work-board-decision-intent.js");
  invoke.mockClear();
  const button = document.createElement("button");
  button.setAttribute(WORK_BOARD_DECISION_ATTRIBUTE, key);
  document.body.append(button);
  button.addEventListener("click", () => { void invokeWorkBoardDecision(WORK_BOARD.decideStage, 7, input); });
  button.click();
  await invokeWorkBoardDecision(WORK_BOARD.decideStage, 7, input);
  expect(invoke.mock.calls).toEqual([[WORK_BOARD.decideStage, 7, input], [WORK_BOARD.decideStage, 7, input]]);
});

it("takes a receipt only for the action on the trusted click's button", async () => {
  vi.resetModules();
  vi.stubGlobal("navigator", { userActivation: { isActive: true } });
  const listen = vi.spyOn(window, "addEventListener");
  const { invokeWorkBoardDecision } = await import("../../src/preload/work-board-decision-intent.js");
  const capture = listen.mock.calls.find(([event]) => event === "click")?.[1] as EventListener;
  const button = document.createElement("button");
  button.setAttribute(WORK_BOARD_DECISION_ATTRIBUTE, key);
  const click = { isTrusted: true, eventPhase: Event.BUBBLING_PHASE, composedPath: () => [button] };
  capture(click as unknown as Event);
  invoke.mockClear();
  await invokeWorkBoardDecision(WORK_BOARD.decideStage, 9, input);
  await invokeWorkBoardDecision(WORK_BOARD.decideStage, 7, input);
  await invokeWorkBoardDecision(WORK_BOARD.decideStage, 7, input);
  expect(invoke.mock.calls).toEqual([
    [WORK_BOARD.decideStage, 9, input],
    [WORK_BOARD.captureDecisionIntent, expect.any(String), key],
    [WORK_BOARD.decideStage, 7, input, invoke.mock.calls[1][1]],
    [WORK_BOARD.decideStage, 7, input],
  ]);
});

it("captures a trusted launch form submission without sampling browser activation", async () => {
  vi.resetModules();
  vi.stubGlobal("navigator", { userActivation: { isActive: false } });
  const listen = vi.spyOn(window, "addEventListener");
  const { invokeWorkBoardDecision } = await import("../../src/preload/work-board-decision-intent.js");
  const capture = listen.mock.calls.find(([event]) => event === "submit")?.[1] as EventListener;
  const form = document.createElement("form");
  const item = { title: "Report", templateId: "report", projectRoot: "/example" };
  const launch = { graphHash: "a".repeat(64), templateId: "report", version: 2, projectRoot: "/example" };
  const binding = workBoardDecisionKey(WORK_BOARD.add, item, launch);
  form.setAttribute(WORK_BOARD_DECISION_ATTRIBUTE, binding);
  capture({ isTrusted: true, target: form, eventPhase: Event.BUBBLING_PHASE } as unknown as Event);
  invoke.mockClear();
  await invokeWorkBoardDecision(WORK_BOARD.add, item, launch);
  expect(invoke.mock.calls).toEqual([
    [WORK_BOARD.captureDecisionIntent, expect.any(String), binding],
    [WORK_BOARD.add, item, launch, invoke.mock.calls[0][1]],
  ]);
});
