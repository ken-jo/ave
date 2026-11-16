import "../../../../test/renderer/setup.js";
import { assert, describe, expect, it } from "vitest";
import { clearSettingsFilter, filterRenderedSettings, renderedSettingText, settingsTextMatchesQuery } from "../settings-search.js";

function settingsFixture() {
  const root = document.createElement("div");
  root.innerHTML = `<div data-settings-panel="appearance"><h2>Appearance</h2><section data-settings-section="appearance-theme" data-settings-description="Choose the application's color theme"><label>Color scheme</label><button role="radio" aria-label="Dark mode">Dark</button><div data-setting-id="appearance.mode" data-setting-modified="true">Mode</div></section><section data-settings-section="appearance-terminal"><label>Terminal font size</label><input aria-label="Terminal font size" value="12" /></section></div><div data-settings-panel="web"><section data-settings-section="web-api-key"><label>Search API key</label><input type="password" aria-label="Search API key" value="fixture-secret" /></section></div>`;
  document.body.append(root); return root;
}

describe("rendered settings search", () => {
  it("filters actual settings in place across tabs without changing control state", () => {
    const root = settingsFixture();
    const input = root.querySelector<HTMLInputElement>('[aria-label="Terminal font size"]');
    const web = root.querySelector<HTMLElement>('[data-settings-panel="web"]');
    assert(input); assert(web);
    const matches = filterRenderedSettings(root, "terminal font");
    expect(matches.map((match) => match.section.dataset.settingsSection)).toEqual(["appearance-terminal"]);
    expect(web.hidden).toBe(true);
    expect(input.value).toBe("12");
    clearSettingsFilter(root); expect(web.hidden).toBe(false);
    root.remove();
  });
  it("leaves no inline display on an inactive tab panel, so the panel shows once it becomes active", () => {
    const root = settingsFixture();
    const web = root.querySelector<HTMLElement>('[data-settings-panel="web"]');
    assert(web);
    web.dataset.state = "inactive";
    filterRenderedSettings(root, "terminal font");
    clearSettingsFilter(root);
    expect(web.hidden).toBe(true);
    expect(web.style.display).toBe("");
    // The tab library flips these when the user selects the tab; nothing else is rewritten.
    web.dataset.state = "active"; web.hidden = false;
    expect(web.style.display).toBe("");
    root.remove();
  });
  it("automatically indexes newly rendered labels, descriptions, ids and accessible names", () => {
    const root = settingsFixture();
    const section = root.querySelector<HTMLElement>("section");
    assert(section);
    expect(filterRenderedSettings(root, "theme")[0]?.section).toBe(section);
    expect(filterRenderedSettings(root, "appearance.mode")[0]?.section).toBe(section);
    section.insertAdjacentHTML("beforeend", '<label>New setting without an index entry</label><input aria-label="새 설정" />');
    expect(filterRenderedSettings(root, "without an index")[0]?.section).toBe(section);
    expect(filterRenderedSettings(root, "새 설정")[0]?.section).toBe(section);
    root.remove();
  });
  it("never indexes input values or secrets", () => {
    const root = settingsFixture();
    const section = root.querySelector<HTMLElement>('[data-settings-section="web-api-key"]');
    assert(section);
    section.insertAdjacentHTML("beforeend", "<textarea>fixture-private-secret</textarea>");
    expect(renderedSettingText(section)).not.toContain("fixture-private-secret");
    expect(filterRenderedSettings(root, "fixture-private-secret")).toEqual([]);
    expect(renderedSettingText(section)).not.toContain("fixture-secret");
    expect(filterRenderedSettings(root, "fixture-secret")).toEqual([]);
    expect(filterRenderedSettings(root, "api key")[0]?.section).toBe(section);
    root.remove();
  });
  it("combines Modified with text filters and restores sections when cleared", () => {
    const root = settingsFixture();
    expect(filterRenderedSettings(root, "", true).map((match) => match.section.dataset.settingsSection)).toEqual(["appearance-theme"]);
    expect(filterRenderedSettings(root, "font", true)).toEqual([]);
    clearSettingsFilter(root);
    expect([...root.querySelectorAll<HTMLElement>("section")].every((section) => !section.hidden)).toBe(true);
    expect(settingsTextMatchesQuery("Search API key", " KEY search ")).toBe(true);
    root.remove();
  });
});
