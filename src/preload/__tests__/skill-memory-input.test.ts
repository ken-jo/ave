import { afterEach, describe, expect, it, vi } from "vitest";
import { requiredFixture } from "../../__tests__/support/required-fixture.js";
import { consumeSkillMemoryOwnerInput, installSkillMemoryInputTracking } from "../skill-memory-input.js";

function setup() {
  const listeners = new Map<string, EventListener>();
  class Textarea {
    dataset = { skillMemorySource: "chat" };
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
  vi.unstubAllGlobals();
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
