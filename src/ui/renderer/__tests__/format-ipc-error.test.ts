import { describe, it, expect } from "vitest";
import {
  formatIpcError,
  COMMON_IPC_ERROR_MESSAGES,
} from "../format-ipc-error.js";
import { getLocale, setLocale, t } from "../../../i18n/runtime.js";

describe("formatIpcError (SOT — #830)", () => {
  it.each([
    ["en", "subscription-runtime-native-required", "This subscription runtime requires a native installation. Run claude install or use the official native installer, then remove the npm-installed copy and check again."],
    ["ko", "subscription-runtime-native-required", "이 구독 실행 환경은 네이티브 설치가 필요합니다. claude install 또는 공식 네이티브 설치 프로그램으로 설치한 다음 npm으로 설치한 복사본을 제거하고 다시 확인하세요."],
    ["ko", "subscription-model-not-supported", "선택한 모델을 사용할 수 없습니다. 설정에서 지원되는 모델을 선택하세요."],
    ["en", "subscription-model-not-supported", "The selected model is unavailable. Choose a supported model in Settings."],
    ["ko", "invalid-send-request-id", "잘못된 입력입니다."],
    ["en", "invalid-send-request-id", "Invalid input."],
    ["ko", "sub-agent-runner-unavailable", "지금은 서브에이전트를 사용할 수 없습니다."],
    ["en", "sub-agent-runner-unavailable", "Sub-agents are unavailable right now."],
    ["ko", "sub-agent-transcript-not-found", "서브에이전트 대화 기록을 찾을 수 없습니다."],
    ["en", "sub-agent-transcript-not-found", "The sub-agent transcript could not be found."],
  ] as const)("localizes the %s message for %s", (locale, code, expectedMessage) => {
    const previousLocale = getLocale();
    try {
      setLocale(locale);
      expect(formatIpcError(code, undefined)).toBe(expectedMessage);
      expect(formatIpcError(code, "Backend detail")).toBe(expectedMessage);
    } finally {
      setLocale(previousLocale);
    }
  });

  it.each([
    ["invalid-arguments", "formatIpcError.invalidInput"],
    ["no-alerts-service", "formatIpcError.notificationUnavailable"],
    ["predecessor-not-removable", "alerts.predecessorNotRemovable"],
    ["predecessor-policy-locked", "alerts.predecessorPolicyLocked"],
    ["predecessor-removal-failed", "alerts.predecessorRemovalFailed"],
  ])("localizes the alert IPC error %s", (code, messageKey) => {
    expect(formatIpcError(code, undefined)).toBe(t(messageKey));
    expect(formatIpcError(code, undefined)).not.toContain(code);
  });

  it("localizes an alert kind that disappeared before consent was submitted", () => {
    expect(formatIpcError("kind-not-registered", undefined)).toBe(
      "이 알림 유형은 더 이상 사용할 수 없습니다. 알림 설정을 새로고침해 주세요.",
    );
  });
  it("resolves a known common code from the default map", () => {
    // The map now holds translation keys; formatIpcError resolves them via t().
    expect(formatIpcError("invalid-key", undefined)).toBe(
      t(COMMON_IPC_ERROR_MESSAGES["invalid-key"]),
    );
  });

  it("Layer-0 directory denials resolve from the shared table, not a raw code", () => {
    // Use the shared IPC error table across surfaces so workspace denials never leak raw codes.
    for (const code of ["path-not-allowed", "sensitive-path"]) {
      const message = formatIpcError(code, undefined);
      expect(message).not.toContain(code);
      expect(message).toBe(t("chatPreviewRail.fileErrorNotAllowed"));
    }
  });

  it("renders the SAME string the removed local codeMap overrides produced", () => {
    // The workspaces panel and the file preview both mapped these two codes to `chatPreviewRail.fileErrorNotAllowed`. Their
    // local copies are gone; this pins that dropping them changed no rendered string.
    const previousOverride = t("chatPreviewRail.fileErrorNotAllowed");
    expect(formatIpcError("path-not-allowed", undefined)).toBe(previousOverride);
    expect(formatIpcError("sensitive-path", undefined)).toBe(previousOverride);
  });

  it("codeMap overrides win over the common default", () => {
    expect(
      formatIpcError("invalid-key", undefined, {
        codeMap: { "invalid-key": "유효하지 않은 승인 키입니다." },
      }),
    ).toBe("유효하지 않은 승인 키입니다.");
  });

  it("returns backend message verbatim when code is unknown and no fallbackContext", () => {
    expect(formatIpcError("never-seen-code", "백엔드가 보낸 메시지입니다")).toBe(
      "백엔드가 보낸 메시지입니다",
    );
  });

  it("prefixes backend message with fallbackContext when supplied", () => {
    expect(
      formatIpcError("never-seen-code", "디테일", {
        fallbackContext: "리뷰어 오류",
      }),
    ).toBe("리뷰어 오류: 디테일");
  });

  it("uses raw code with fallbackContext when message is empty", () => {
    expect(
      formatIpcError("never-seen-code", undefined, {
        fallbackContext: "리뷰어 오류",
      }),
    ).toBe("리뷰어 오류: never-seen-code");
  });

  it("returns generic Korean fallback when both code and message are absent", () => {
    expect(formatIpcError(undefined, undefined)).toBe("알 수 없는 오류가 발생했습니다.");
  });

  it("recognizes intent-gate code from cross-cutting PR #826", () => {
    expect(formatIpcError("user-keyboard-required", undefined)).toContain(
      "활성 사용자 입력",
    );
  });

  it("maps reviewer-rewire-failed to the Korean rollback message", () => {
    expect(formatIpcError("reviewer-rewire-failed", undefined)).toContain(
      "권한 검토 모델",
    );
  });
});
