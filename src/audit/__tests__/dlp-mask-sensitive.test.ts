import { describe, it, expect } from "vitest";
import { maskSensitiveData, redactForLLM } from "../dlp-filter.js";
import { fixtureSecret } from "./secret-fixtures.js";

function masksCase(text: string, original: string, replacement: string, detection: string) {
  return () => {
    const { masked, detections } = maskSensitiveData(text);
    expect(masked).not.toContain(original);
    expect(masked).toContain(replacement);
    expect(detections).toContain(detection);
  };
}

describe("maskSensitiveData — 주민등록번호 (Korean RRN)", () => {
  it("masks a valid RRN with hyphen",
    masksCase("주민번호: 900101-1234567", "900101-1234567", "******-*******", "주민등록번호"));

  it("does not mask a RRN-like string with gender digit outside [1-4]", () => {
    const { masked } = maskSensitiveData("900101-5234567");
    expect(masked).toContain("900101-5234567");
  });

  it("masks multiple RRNs in a single string", () => {
    const { masked, detections } = maskSensitiveData("A 900101-1234567 B 851212-2345678");
    expect(masked).not.toContain("900101-1234567");
    expect(masked).not.toContain("851212-2345678");
    expect(detections).toContain("주민등록번호");
  });
});

describe("maskSensitiveData — 신용카드 (credit card)", () => {
  // Use a Luhn-valid card and preserve only its last four digits and separators.
  it("masks a Luhn-valid 16-digit card with spaces, preserves last 4 and grouping",
    masksCase("카드: 4111 1111 1111 1111", "4111 1111 1111 1111", "**** **** **** 1111", "신용카드"));

  it("masks a Luhn-valid 16-digit card with hyphens", () => {
    const { masked } = maskSensitiveData("card: 4111-1111-1111-1111");
    expect(masked).not.toContain("4111-1111-1111-1111");
    expect(masked).toContain("****-****-****-1111");
  });

  it("masks a Luhn-valid 16-digit card without separators",
    masksCase("num: 4111111111111111", "4111111111111111", "************1111", "신용카드"));

  // Display and model redactors must both leave non-Luhn digit runs intact.
  it("leaves a card-length digit run that fails Luhn intact", () => {
    const { masked, detections } = maskSensitiveData("주문번호: 1234 5678 9012 3456");
    expect(masked).toContain("1234 5678 9012 3456");
    expect(detections).not.toContain("신용카드");
  });
});

describe("maskSensitiveData — API 키 (sk- prefix)", () => {
  it("masks OpenAI-style API key", () => {
    const { masked, detections } = maskSensitiveData("key=sk-abcdefghijklmnopqrst");
    expect(masked).not.toContain("sk-abcdefghijklmnopqrst");
    expect(masked).toContain("[REDACTED:TOKEN]");
    expect(masked).not.toContain(`sk-${"*".repeat(4)}`);
    expect(detections).toContain("자격 증명");
    expect(detections).not.toContain("API 키");
  });

  it("masks longer API key", () => {
    const { masked } = maskSensitiveData(`key=sk-${"x".repeat(40)}`);
    expect(masked).toContain("[REDACTED:TOKEN]");
  });

  it("does NOT mask sk- with fewer than 20 chars (too short to be a real key)", () => {
    const { masked, detections } = maskSensitiveData("sk-abc123");
    // The token pattern requires at least 20 alphanumeric characters after sk-.
    expect(detections).not.toContain("API 키");
    expect(masked).toContain("sk-abc123");
  });

  it("uses the shared credential scrubber for vendor-prefixed tokens", () => {
    const githubPat = fixtureSecret("gh", "p_", "1234567890abcdefghijklmnopqrstuv");
    const slackApp = fixtureSecret("xa", "pp-", "123456789012-123456789012-abcdefghijklmnopqrstuv");
    const { masked, detections } = maskSensitiveData(`tokens ${githubPat} ${slackApp}`);

    expect(masked).not.toContain(githubPat);
    expect(masked).not.toContain(slackApp);
    expect(masked.match(/\[REDACTED:TOKEN\]/g)?.length).toBe(2);
    expect(detections).toContain("자격 증명");
  });
});

describe("maskSensitiveData — 전화번호 (Korean 010)", () => {
  it("masks 010-XXXX-XXXX format",
    masksCase("내 번호: 010-1234-5678", "010-1234-5678", "010-****-****", "전화번호"));

  it("masks multiple phone numbers", () => {
    const { masked } = maskSensitiveData("010-1111-2222 and 010-3333-4444");
    expect(masked).not.toContain("010-1111-2222");
    expect(masked).not.toContain("010-3333-4444");
  });
});

describe("maskSensitiveData — 이메일 (email)", () => {
  it("preserves domain while masking local part",
    masksCase("이메일: user@example.com", "user@example.com", "***@example.com", "이메일"));

  it("masks email in plain text context", () => {
    const { masked } = maskSensitiveData("contact admin@company.co.kr for help");
    expect(masked).not.toContain("admin@company.co.kr");
    expect(masked).toContain("***@company.co.kr");
  });
});

describe("maskSensitiveData — clean text (no false positives)", () => {
  it("returns text unchanged when no PII present", () => {
    const text = "Hello Ave, this is a normal message without any sensitive data.";
    const { masked, detections } = maskSensitiveData(text);
    expect(masked).toBe(text);
    expect(detections).toHaveLength(0);
  });

  it("does not flag a normal number sequence as a credit card", () => {
    const { detections } = maskSensitiveData("order #12345 shipped");
    expect(detections).not.toContain("신용카드");
  });

  it("returns detections array listing only matched pattern names", () => {
    const { detections } = maskSensitiveData("api key: sk-abcdefghijklmnopqrstu email: x@y.com");
    expect(detections).toContain("자격 증명");
    expect(detections).toContain("이메일");
    expect(detections).not.toContain("API 키");
    expect(detections).not.toContain("신용카드");
    expect(detections).not.toContain("전화번호");
  });

  it("handles empty string", () => {
    const { masked, detections } = maskSensitiveData("");
    expect(masked).toBe("");
    expect(detections).toHaveLength(0);
  });
});

// Both entry points must agree on detection despite different replacement shapes.
describe("converged detection — maskSensitiveData and redactForLLM agree", () => {
  it("both catch a dashless Korean mobile form", () => {
    const text = "번호 01098765432";
    const { masked, detections } = maskSensitiveData(text);
    expect(masked).not.toContain("01098765432");
    expect(masked).toContain("010********");
    expect(detections).toContain("전화번호");

    const r = redactForLLM(text);
    expect(r.redacted).not.toContain("01098765432");
    expect(r.counts.PHONE_KR).toBe(1);
  });

  it("both catch a non-010 carrier-prefix mobile form", () => {
    const text = "번호 016-234-5678";
    expect(maskSensitiveData(text).detections).toContain("전화번호");
    expect(redactForLLM(text).counts.PHONE_KR).toBe(1);
  });

  it("both catch a 15-digit Luhn-valid card", () => {
    const text = "카드 378282246310005";
    const { masked, detections } = maskSensitiveData(text);
    expect(masked).not.toContain("378282246310005");
    expect(masked).toContain("***********0005");
    expect(detections).toContain("신용카드");

    const r = redactForLLM(text);
    expect(r.redacted).not.toContain("378282246310005");
    expect(r.counts.CREDIT_CARD).toBe(1);
  });

  it("both catch a US phone number", () => {
    const text = "call 415-555-1234";
    expect(maskSensitiveData(text).detections).toContain("전화번호");
    expect(redactForLLM(text).counts.PHONE_US).toBe(1);
  });

  // Neither entry point may over-mask invalid cards or ids embedded in longer digit runs.
  it("both leave a non-Luhn card-length run intact", () => {
    const text = "주문 1234 5678 9012 3456";
    expect(maskSensitiveData(text).masked).toContain("1234 5678 9012 3456");
    expect(redactForLLM(text).counts.CREDIT_CARD ?? 0).toBe(0);
  });

  it("both leave a resident-ID shape embedded in a longer digit run intact", () => {
    const text = "ref 99900101-1234567";
    expect(maskSensitiveData(text).detections).not.toContain("주민등록번호");
    expect(redactForLLM(text).counts.SSN_KR ?? 0).toBe(0);
  });
});

// The privacy toggle governs PII only; credentials must always be removed.
describe("maskSensitiveData — pii: false (privacy toggle off)", () => {
  it("leaves every PII class intact and reports no detection", () => {
    const text = [
      "email user@example.com",
      "phone 010-1234-5678",
      "us phone 415-555-1234",
      "rrn 900101-1234567",
      "card 4111 1111 1111 1111",
    ].join(" / ");

    const { masked, detections } = maskSensitiveData(text, { pii: false });

    expect(masked).toBe(text);
    expect(detections).toEqual([]);
  });

  it("still scrubs a credential and names only the credential class", () => {
    const text = `key=${fixtureSecret("sk", "-", "abcdefghijklmnopqrst")} email user@example.com`;

    const { masked, detections } = maskSensitiveData(text, { pii: false });

    expect(masked).toContain("[REDACTED:TOKEN]");
    expect(masked).toContain("user@example.com");
    expect(detections).toEqual(["자격 증명"]);
  });

  it("matches the default and pii: true when the toggle is on", () => {
    const text = "email user@example.com phone 010-1234-5678";

    expect(maskSensitiveData(text, { pii: true })).toEqual(maskSensitiveData(text));
    expect(maskSensitiveData(text, { pii: true }).masked).not.toBe(text);
  });
});
