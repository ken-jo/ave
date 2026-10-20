import { describe, expect, it } from "vitest";
import { PII_PATTERNS } from "../../shared/dlp.js";
import { isSafeStructuralId } from "../../shared/dlp-safe-id.js";
import { maskSensitiveData, redactForLLM } from "../dlp-filter.js";

describe("international phone content detection", () => {
  it.each([
    "+82-10-1234-5678",
    "+82 10 1234 5678",
    "+821012345678",
    "+82 (2) 1234-5678",
    "+44 20 7946 0958",
    "+44-7700-900123",
    "+442079460958",
    "+81-90-1234-5678",
    "+81 (3) 1234-5678",
    "+81312345678",
    "+1-212-555-0100",
    "+1 (212) 555-0100",
    "+1.212.555.0100",
    "+12125550100",
    "+33 1 23 45 67 89",
    "+420.777.123.456",
    "+351.912.345.678",
    "+12345678",
    "+123456789012345",
  ])("masks and fully redacts the same complete number: %s", (phone) => {
    const text = `Call ${phone}, please.`;
    const display = maskSensitiveData(text);
    expect(display.masked).toBe(`Call ${phone.replace(/\d/g, "*")}, please.`);
    expect(display.detections).toContain("전화번호");
    expect(redactForLLM(text)).toMatchObject({
      redacted: "Call [REDACTED:PHONE], please.",
      counts: { PHONE_INTL: 1 },
      totalCount: 1,
    });
    expect(maskSensitiveData(text, { pii: false })).toEqual({ masked: text, detections: [] });
  });

  it.each([
    "abcdefab-cdef-4abc-8def-abcdefabcdef",
    "sub-abcd1234-abcdefab-cdef-4abc-8def-abcdefabcdef",
    "v1.2.3",
    "v1.2.3+123456789",
    "2026-10-20",
    "+2026-10-20",
    "+20261020",
    "+2026-10-20T10:30:00Z",
    "+2026-10-20 10:30:00",
    "192.168.100.100",
    "+192.168.100.100",
    "2001:db8::1",
    "order #123456789012",
    "ORD-1234-5678-9012",
    "order+442079460958",
    "ref_+821012345678",
    "ref-+819012345678",
    "ref.+12125550100",
    "+442079460958-order",
    "+442079460958.order",
    "+442079460958suffix",
    "+442079460958_7",
    "+1234567",
    "+0123456789",
    "+1234567890123456",
    "+123456789012345-6",
  ])("leaves non-phone tokens intact: %s", (text) => {
    expect(maskSensitiveData(text)).toEqual({ masked: text, detections: [] });
    expect(redactForLLM(text)).toMatchObject({ redacted: text, totalCount: 0 });
  });

  it.each(["2026-10-20", "20261020", "1234"])("still redacts a phone before a separate numeric field: %s", (field) => {
    const text = `Call +442079460958 ${field}`;
    expect(maskSensitiveData(text).masked).toBe(`Call +************ ${field}`);
    expect(redactForLLM(text)).toMatchObject({
      redacted: `Call [REDACTED:PHONE] ${field}`,
      counts: { PHONE_INTL: 1 },
    });
  });

  it("does not add international matches to colliding UUID keys or UUID-shaped content", () => {
    const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-010123456789";
    const international = PII_PATTERNS.find((pattern) => pattern.kind === "PHONE_INTL")!;
    international.pattern.lastIndex = 0;
    expect(international.pattern.test(uuid)).toBe(false);
    expect(redactForLLM(uuid).counts.PHONE_INTL ?? 0).toBe(0);
    expect(isSafeStructuralId(uuid)).toBe(true);
    // UUID-looking text keeps the existing local-phone content policy.
    expect(redactForLLM(uuid).counts.PHONE_KR).toBe(1);
  });
});
