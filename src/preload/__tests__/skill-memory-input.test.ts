import { afterEach, describe, expect, it, vi } from "vitest";
import { requiredFixture } from "../../__tests__/support/required-fixture.js";
import { consumeSkillMemoryOwnerInput, installSkillMemoryInputTracking } from "../skill-memory-input.js";
import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { workBoardApiSurface } from "../work-board-api-surface.js";

const { invoke, invokeDecision } = vi.hoisted(() => ({ invoke: vi.fn(), invokeDecision: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));
vi.mock("../work-board-decision-intent.js", () => ({ invokeWorkBoardDecision: invokeDecision }));

function setup(source = "chat") {
  const listeners = new Map<string, EventListener>();
  class Textarea {
    dataset = { skillMemorySource: source };
    value = "";
    isConnected = true;
  }
  const element = new Textarea();
  vi.stubGlobal("HTMLTextAreaElement", Textarea);
  vi.stubGlobal("document", { addEventListener: (type: string, listener: EventListener) => { listeners.set(type, listener); } });
  installSkillMemoryInputTracking();
  return {
    element,
    edit(inputType: string, value: string, isTrusted = true) {
      const event = { target: element, inputType, isTrusted } as unknown as Event;
      requiredFixture(listeners.get("beforeinput"))(event);
      element.value = value;
      requiredFixture(listeners.get("input"))(event);
    },
  };
}

afterEach(() => {
  consumeSkillMemoryOwnerInput("chat", undefined);
  consumeSkillMemoryOwnerInput("work-board", undefined);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("work-board add preload", () => {
  const input = { title: "Review", detail: "Run the checks." };

  it("forwards the exact native-typed detail as one-use evidence", async () => {
    const f = setup("work-board");
    f.edit("insertText", input.detail);
    await workBoardApiSurface.addWorkBoardItem(input);
    await workBoardApiSurface.addWorkBoardItem(input);
    expect(invoke.mock.calls).toEqual([
      [WORK_BOARD.add, input, undefined, undefined, true],
      [WORK_BOARD.add, input],
    ]);
  });

  it("omits evidence on paste and on programmatic detail replacement", async () => {
    const f = setup("work-board");
    f.edit("insertFromPaste", input.detail);
    await workBoardApiSurface.addWorkBoardItem(input);
    f.element.value = "";
    f.edit("insertText", "Different typed detail.");
    f.element.value = input.detail;
    await workBoardApiSurface.addWorkBoardItem(input);
    expect(invoke.mock.calls).toEqual([[WORK_BOARD.add, input], [WORK_BOARD.add, input]]);
  });

  it("passes typed detail evidence through the template decision path", async () => {
    const f = setup("work-board");
    const launch = { templateId: "review", version: 1, graphHash: "a".repeat(64) };
    f.edit("insertText", input.detail);
    await workBoardApiSurface.addWorkBoardItem(input, launch);
    expect(invokeDecision).toHaveBeenCalledExactlyOnceWith(WORK_BOARD.add, input, launch, true);
  });
});

describe("preload owner text evidence", () => {
  it("spends native typing evidence once for the exact outgoing text", () => {
    const f = setup();
    f.edit("insertText", "Run");
    f.edit("insertCompositionText", "Run checks.");
    expect(consumeSkillMemoryOwnerInput("chat", "Run checks.")).toBe(true);
    expect(consumeSkillMemoryOwnerInput("chat", "Run checks.")).toBe(false);
  });

  it("does not treat native paste, a synthetic edit, or programmatic draft replacement as owner text", () => {
    const f = setup();
    f.edit("insertFromPaste", "Foreign instruction.");
    f.edit("insertText", "Foreign instruction.!");
    expect(consumeSkillMemoryOwnerInput("chat", "Foreign instruction.!")).toBe(false);
    f.element.value = "";
    f.edit("insertText", "Synthetic", false);
    expect(consumeSkillMemoryOwnerInput("chat", "Synthetic")).toBe(false);
    f.element.value = "";
    f.edit("insertText", "Owner text");
    f.element.value = "Prefilled text";
    expect(consumeSkillMemoryOwnerInput("chat", "Prefilled text")).toBe(false);
  });
});
