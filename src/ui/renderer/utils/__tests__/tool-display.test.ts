import { describe, expect, it } from "vitest";

import { getToolCallLabel, getToolDisplayName } from "../tool-display.js";
import { en, ko } from "../../../../i18n/messages/generated/toolDisplay.js";

describe("tool display names", () => {
  it("labels read_tool_result_chunk instead of leaking raw identifier text", () => {
    expect(getToolDisplayName("read_tool_result_chunk")).toBe("도구 결과 청크 읽기");
  });
});

describe("tool call labels", () => {
  it("names the skill on a skill read so the read step is visible", () => {
    expect(getToolCallLabel("skill_load", { skillName: "email-polish" })).toBe("스킬 읽기 · email-polish");
    expect(getToolCallLabel("skill_read", { skillName: "guide", resourcePath: "references/api.md" })).toBe(
      "스킬 파일 읽기 · guide/references/api.md",
    );
  });

  it("falls back to the display name when the subject is missing", () => {
    expect(getToolCallLabel("skill_load", {})).toBe("스킬 읽기");
    expect(getToolCallLabel("skill_load", undefined)).toBe("스킬 읽기");
    expect(getToolCallLabel("bash", { command: "ls" })).toBe(getToolDisplayName("bash"));
  });

  it("ships every skill label key in both en and ko", () => {
    const keys = [
      "toolDisplay.skillLoad",
      "toolDisplay.skillLoadNamed",
      "toolDisplay.skillRead",
      "toolDisplay.skillReadNamed",
      "toolDisplay.skillList",
    ] as const;
    for (const key of keys) {
      expect(en[key], `en ${key}`).toBeTruthy();
      expect(ko[key], `ko ${key}`).toBeTruthy();
    }
    expect(en["toolDisplay.skillLoadNamed"]).toContain("{name}");
    expect(ko["toolDisplay.skillReadNamed"]).toContain("{path}");
  });
});
