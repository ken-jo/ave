import { describe, expect, it } from "vitest";
import { en } from "../../../../i18n/messages/en.js";
import { ko } from "../../../../i18n/messages/ko.js";
import { interpolate } from "../../../../i18n/translate.js";
import { apiModelBillingRoute, modelBillingDisclosure } from "../model-billing.js";

for (const [locale, messages, subscription, apiKey] of [
  ["en", en, "Billed to your own Claude subscription, not an API key.", "Billed to your configured API key."],
  ["ko", ko, "API 키가 아닌 본인의 Claude 구독으로 청구됩니다.", "설정한 본인의 API 키로 청구됩니다."],
] as const) {
  describe(`model billing disclosure in ${locale}`, () => {
    const translate = (key: string, vars?: Parameters<typeof interpolate>[1]) =>
      interpolate((messages as Record<string, string>)[key] ?? key, vars);

    it("distinguishes a subscription from API-key authentication", () => {
      expect(modelBillingDisclosure({ kind: "subscription", provider: "claude-code" }, translate)).toBe(subscription);
      expect(modelBillingDisclosure(apiModelBillingRoute("claude", true, true), translate)).toBe(apiKey);
    });

    it("uses the configured key on an optional route and the exact preset's requirement", () => {
      expect(modelBillingDisclosure(apiModelBillingRoute("openai-compatible", false, true), translate)).toBe(apiKey);
      expect(modelBillingDisclosure(apiModelBillingRoute("openai-compatible", true, true), translate)).toBe(apiKey);
      expect(modelBillingDisclosure(apiModelBillingRoute("openai-compatible", false, false), translate)).toBeUndefined();
      expect(modelBillingDisclosure(apiModelBillingRoute("vertex-ai", true, true), translate)).toBeUndefined();
      expect(modelBillingDisclosure(undefined, translate)).toBeUndefined();
    });
  });
}
