#!/usr/bin/env node
// Write catalog barrels from the shared assembler output.
import { writeFileSync } from "node:fs";
import { buildI18nCatalogArtifacts } from "./i18n-catalog-artifacts.mjs";

const { fragments, artifacts } = buildI18nCatalogArtifacts();
for (const { path, content } of artifacts) {
  writeFileSync(path, content, "utf-8");
}
console.log(`[i18n] assembled ${fragments.length} fragment(s) into generated/index.ts + generated-locales/ko.ts`);
