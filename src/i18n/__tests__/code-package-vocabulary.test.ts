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
  "pluginPromptOrigin.packageAuthored": ["<plugin-prompt>"],
  "routinePanel.templateSuggestedScope": ["{plugins}"],
  "routinePanel.createdFromPluginTemplate": ["{plugin}"],
  "routinePanel.createdFromExtensionTemplate": ["{plugin}"],
  "be_routineSchedule.templateSourceDescription": ["agent-plugin:<package>:<templateId>"],
  "be_systemPromptBuilder.toolSchemasSourceNote": ["plugin:<id>"],
  "be_systemPromptBuilder.toolCatalogGroupingNote": ["plugin:<id>"],
  "defaultTourScenarios.meetingSummaryStep3Body": ["~/.ave/plugins/"],
  "gitMarketplace.direct.gitHelp": ["plugin.json"],
};

// Agent-plugin-only views intentionally use Plugin/플러그인. Strip only the
// exact phrase so another stale package reference on the same key still fails.
const BUNDLE_WORDING: Record<string, Partial<Record<"en" | "ko", string>>> = {
  "agentPluginPrompt.argsDescription": { ko: "플러그인의 템플릿" },
  "agentPluginPrompt.failed": { en: "plugin prompt", ko: "플러그인 프롬프트" },
  "be_routineSchedule.templateSourceDescription": { en: "plugin template", ko: "플러그인 템플릿" },
  "gitMarketplace.kind.agentPlugin": { en: "Plugins", ko: "플러그인" },
  "gitMarketplace.review.mcpConsentTitle": { en: "Plugin server consent", ko: "플러그인 서버 실행 승인" },
  "gitMarketplace.review.mcpConsentHelp": { ko: "플러그인 데이터 디렉터리" },
  "gitMarketplace.server.plugin": { en: "Plugin", ko: "플러그인" },
  "gitMarketplace.uninstall.removePluginData": { en: "plugin's data", ko: "플러그인의 데이터" },
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
        const bundleWording = BUNDLE_WORDING[key]?.[locale as "en" | "ko"];
        if (bundleWording) prose = prose.replaceAll(bundleWording, "");
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
