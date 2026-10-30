import { describe, expect, it } from "vitest";
import { normalizeRationaleApprovalDisplayText } from "../rationale-approval-display.js";

describe("rationale audit text normalization", () => {
  it("removes invisible control characters while retaining explanatory text", () => {
    expect(normalizeRationaleApprovalDisplayText("한국어\u202E 경로\u2066 와 C1\u0085 제어문자")).toBe("한국어 경로 와 C1 제어문자");
    expect(normalizeRationaleApprovalDisplayText("생성된 빌드 출력만 삭제합니다.")).toBe("생성된 빌드 출력만 삭제합니다.");
  });
});
