import { describe, expect, it } from "vitest";
import { searchSettings } from "../settings-search.js";
import { SETTINGS_SECTIONS } from "../../../shared/settings-tabs.js";
import { en as seedEn } from "../../../i18n/messages/en.js";
import { ko as seedKo } from "../../../i18n/messages/ko.js";
import { generatedEn } from "../../../i18n/messages/generated/index.js";
import { koMessages as generatedKo } from "../../../i18n/messages/generated-locales/ko.js";

const en: Record<string, string> = { ...seedEn, ...generatedEn };
const ko: Record<string, string> = { ...seedKo, ...generatedKo };
const translate = (messages: Record<string, string>) => (key: string) => messages[key] ?? key;

describe("settings search", () => {
  it("matches localized setting labels and section titles", () => {
    expect(searchSettings(" LINE HEIGHT ", translate(en)).map((result) => result.section)).toContain("appearance-terminal");
    expect(searchSettings("줄 높이", translate(ko)).map((result) => result.section)).toContain("appearance-terminal");
    expect(searchSettings("색상 스킴", translate(ko)).map((result) => result.section)).toContain("appearance-theme");
    for (const [key, section] of [["privacyTab.piiRedactToggleLabel", "chat-privacy"], ["documentSettings.link", "chat-documents"], ["localApiSurfaces.a2aRemoteReceiverLabel", "remote-local-api"], ["tailnetObserver.portLabel", "remote-tailnet-observer"]]) {
      expect(searchSettings(en[key]!, translate(en)).map((result) => result.section)).toContain(section);
      expect(searchSettings(ko[key]!, translate(ko)).map((result) => result.section)).toContain(section);
    }
  });

  it("returns no results for an empty or unknown query", () => {
    expect(searchSettings("  ", translate(en))).toEqual([]);
    expect(searchSettings("unrecognized-setting-9999", translate(en))).toEqual([]);
  });

  it("indexes every registered section once using catalog keys", () => {
    const results = searchSettings("match", () => "match");
    expect(results.map((entry) => entry.section).sort()).toEqual(Object.values(SETTINGS_SECTIONS).flat().sort());
    for (const entry of results) {
      expect(SETTINGS_SECTIONS[entry.tab]).toContain(entry.section);
      for (const key of [entry.title, ...entry.labels]) {
        expect(en[key], key).toBeTruthy();
        expect(ko[key], key).toBeTruthy();
      }
    }
  });
});
