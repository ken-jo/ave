import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { en, ko } from "../../src/i18n/messages/generated/llmTab.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("model catalog disclosures", () => {
  it.each([["en", en], ["ko", ko]] as const)("describes limits without claiming catalog pricing in %s", (_locale, messages) => {
    expect(messages["llmTab.modelCatalogDesc"]).not.toMatch(/list prices|공시 단가/);
    expect(messages["llmTab.modelCatalogHelp"]).toMatch(/IP/);
    expect(messages["llmTab.modelCatalogHelp"]).toMatch(/headers|헤더/);
  });

  // The site's guide keeps both locales in one data file: `const ko` first, then `const en`.
  const guide = readFileSync(join(root, "web/lib/docs.ts"), "utf-8");
  const enAt = guide.indexOf("\nconst en:");
  const guideLocales = { ko: guide.slice(guide.indexOf("\nconst ko:"), enAt), en: guide.slice(enAt) };

  it.each(["en", "ko"] as const)("scopes domain permissions and discloses the fixed-source boundary in %s", (locale) => {
    const source = guideLocales[locale];
    expect(source.length).toBeGreaterThan(0);
    expect(source).toMatch(/grant plugins no additional access|플러그인에게 추가 접근을 주지 않습니다/);
    expect(source).not.toMatch(/list price come from|공시 단가는|There's no such thing as an allow-listed domain|코드에 박혀 있는 허용 도메인/);
    expect(source).toMatch(/redirects are refused|리다이렉트는 거부/);
    expect(source).toMatch(/after decompression|압축을 푼 본문/);
    expect(source).toMatch(/existing price table|기존 단가표/);
  });
});
