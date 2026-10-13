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

  it.each([
    ["en", "web/app/en/docs/host/trust-security/page.tsx"],
    ["ko", "web/app/docs/host/trust-security/page.tsx"],
  ])("scopes domain permissions and discloses the fixed-source boundary in %s", (_locale, path) => {
    const source = readFileSync(join(root, path!), "utf-8");
    expect(source).not.toMatch(/list price come from|공시 단가는|There's no such thing as an allow-listed domain|코드에 박혀 있는 허용 도메인/);
    expect(source).toMatch(/redirects are refused|리다이렉트는 거부/);
    expect(source).toMatch(/after decompression|압축을 푼 본문/);
    expect(source).toMatch(/existing price table|기존 단가표/);
  });
});
