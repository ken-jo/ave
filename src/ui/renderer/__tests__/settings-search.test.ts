import { describe, expect, it } from "vitest";
import { searchSettings } from "../settings-search.js";
import { SETTINGS_SECTIONS } from "../../../shared/settings-tabs.js";
import { en as englishMessages } from "../../../i18n/messages/en.js";
import { ko as koreanMessages } from "../../../i18n/messages/ko.js";

const en: Record<string, string> = englishMessages;
const ko: Record<string, string> = koreanMessages;
const translate = (messages: Record<string, string>) => (key: string) => messages[key] ?? key;

describe("settings search", () => {
  it("matches localized setting labels and section titles", () => {
    expect(searchSettings(" LINE HEIGHT ", translate(en)).map((result) => result.section)).toContain("appearance-terminal");
    expect(searchSettings("줄 높이", translate(ko)).map((result) => result.section)).toContain("appearance-terminal");
    expect(searchSettings("색상 스킴", translate(ko)).map((result) => result.section)).toContain("appearance-theme");
    for (const query of ["glass", "transparency", "유리", "투명도"]) {
      expect(searchSettings(query, translate(query.match(/[a-z]/) ? en : ko)).map((result) => result.section)).toContain("appearance-theme");
    }
    for (const [key, section] of [["privacyTab.piiRedactToggleLabel", "chat-privacy"], ["documentSettings.link", "chat-documents"], ["localApiSurfaces.a2aRemoteReceiverLabel", "remote-local-api"], ["tailnetObserver.portLabel", "remote-tailnet-observer"]]) {
      expect(searchSettings(en[key]!, translate(en)).map((result) => result.section)).toContain(section);
      expect(searchSettings(ko[key]!, translate(ko)).map((result) => result.section)).toContain(section);
    }
  });

  it("finds the shortcuts page by any shortcut's label", () => {
    for (const key of ["shortcuts.label.search", "mainPanels.command.reopenClosed", "be_main.menuNewWindow"]) {
      expect(searchSettings(String(en[key]), translate(en)).map((result) => result.section)).toContain("shortcuts-list");
      expect(searchSettings(String(ko[key]), translate(ko)).map((result) => result.section)).toContain("shortcuts-list");
    }
    expect(searchSettings("keyboard", translate(en)).map((result) => result.section)).toContain("shortcuts-list");
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
