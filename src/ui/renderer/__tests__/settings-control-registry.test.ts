import "../../../../test/renderer/setup.js";
import { assert, describe, expect, it } from "vitest";
import { _unregisteredSettingsControlsForTest } from "../context/SettingsEditorContext.js";

describe("settings control registration coverage", () => {
  it("rejects a newly rendered editable control until its canonical descriptor exists", () => {
    const root = document.createElement("div");
    root.innerHTML = '<section data-settings-section="example"><input aria-label="New preference"/><input aria-label="Filter" data-settings-transient="query"/><input aria-label="Registered preference" data-setting-id="appearance.mode"/><div data-setting-id="appearance.mode" data-setting-registered="true"></div></section>';
    expect(_unregisteredSettingsControlsForTest(root)).toEqual(["input:New preference"]);
    const preference = root.querySelector('input[aria-label="New preference"]');
    assert(preference);
    preference.setAttribute("data-setting-id", "chat.autoCompact");
    expect(_unregisteredSettingsControlsForTest(root)).toEqual(["input:New preference"]);
    root.insertAdjacentHTML("beforeend", '<div data-setting-id="chat.autoCompact" data-setting-registered="true"></div>');
    expect(_unregisteredSettingsControlsForTest(root)).toEqual([]);
    const section = root.querySelector("section");
    assert(section);
    section.setAttribute("data-settings-transient", "all");
    expect(_unregisteredSettingsControlsForTest(root)).toContain("blanket-transient:example");
  });
  it("requires registration for a custom checkbox", () => {
    const root = document.createElement("div");
    root.innerHTML = '<button role="checkbox" aria-label="Extra preference"></button>';
    expect(_unregisteredSettingsControlsForTest(root)).toEqual(["button:Extra preference"]);
  });
});
