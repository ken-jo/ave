import { describe, expect, it } from "vitest";
import { matchSettingsText } from "../settings-text-match.js";

describe("settings text matches", () => {
  it("returns exact case-insensitive ranges for highlighting", () => {
    expect(matchSettingsText("THEME", "Application theme")).toEqual([{ start: 12, end: 17 }]);
    expect(matchSettingsText("검색", "웹 검색 엔진")).toEqual([{ start: 2, end: 4 }]);
    expect(matchSettingsText("", "Application theme")).toEqual([]);
    expect(matchSettingsText("not found", "theme")).toBeNull();
  });
});
