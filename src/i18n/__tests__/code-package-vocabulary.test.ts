import { describe, expect, it } from "vitest";
import { loadAllLocaleMessages } from "../messages/index.js";

// These are identifiers, paths, and interpolation slots, not package names in prose.
// Keep each exception tied to its catalog key so new prose on the same key is checked.
const TECHNICAL_LITERALS: Record<string, readonly string[]> = {
  "routinePanel.pluginsMissing": ["{plugins}"],
  "routinePanel.pluginsPartlyMissing": ["{plugins}"],
  "mainDialog.pluginPickFolderTitle": ["{plugin}"],
  "mainDialog.installLocalPluginMessage": ["plugin.json"],
  "approvalAttribution.pluginRequest": ["{plugin}"],
  "gitMarketplace.authority.pluginAccess": ["{plugin}"],
  "workBoard.proposalSourceLabel": ["{plugin}"],
  "be_systemPromptBuilder.toolSchemasSourceNote": ["plugin:<id>"],
  "be_systemPromptBuilder.toolCatalogGroupingNote": ["plugin:<id>"],
  "defaultTourScenarios.meetingSummaryStep3Body": ["~/.ave/plugins/"],
  "gitMarketplace.direct.gitHelp": ["plugin.json"],
};

const OLD_PACKAGE_WORD = /\bplugins?\b|플러그인/iu;

describe("code package vocabulary in built-in catalogs", () => {
  it("uses extension wording in both locales outside preserved identifiers", async () => {
    const catalogs = await loadAllLocaleMessages();
    const stale: string[] = [];

    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        let prose = value;
        for (const literal of TECHNICAL_LITERALS[key] ?? []) {
          prose = prose.replaceAll(literal, "");
        }
        if (OLD_PACKAGE_WORD.test(prose)) stale.push(`${locale}:${key}`);
      }
    }

    expect(stale).toEqual([]);
  });

  it("preserves the interpolation slot supplied by package-name callers", async () => {
    const catalogs = await loadAllLocaleMessages();
    const keys = [
      "approvalAttribution.pluginRequest",
      "gitMarketplace.authority.pluginAccess",
      "workBoard.proposalSourceLabel",
    ];

    for (const catalog of Object.values(catalogs)) {
      for (const key of keys) {
        expect(catalog[key]).toContain("{plugin}");
      }
    }
  });
});
