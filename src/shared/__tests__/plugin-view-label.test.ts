/**
 * The plugin UI extension label — one derivation for the main-window sidebar
 * (`ui/renderer/api-client.ts`, consumed by App/Sidebar/command-actions), the
 * main process (app menu, floating dock) and the plugin-shell bundle.
 *
 * The fallback chain is pinned once here, step by step, and the type-level
 * checks below pin that both consumer types still satisfy the shared parameter,
 * so the shared function cannot narrow away from its callers.
 */
import { describe, it, expect } from "vitest";
import {
  getPluginViewDescription,
  getPluginViewLabel,
  getPluginViewTitle,
  type PluginViewLabelSource,
} from "../plugin-view-label.js";
import { normalizePluginLocaleTag } from "../plugin-localized-text.js";
import type { PluginUiExtensionView } from "../../plugin-ui-host.js";
import type { PluginUiExtension } from "../../ui/renderer/types.js";

// Both consumer types must remain assignable to the shared parameter. These
// red at typecheck (not at runtime) if either shape drifts away from it.
const _hostViewIsAssignable: PluginViewLabelSource = {} as PluginUiExtensionView;
const _rendererViewIsAssignable: PluginViewLabelSource = {} as PluginUiExtension;
void _hostViewIsAssignable;
void _rendererViewIsAssignable;

function view(
  extension: Partial<PluginViewLabelSource["extension"]> & { title: string },
  pluginId = "com.acme.weather",
): PluginViewLabelSource {
  return { pluginId, extension };
}

describe("getPluginViewLabel — own fields", () => {
  it("prefers the author-chosen displayName", () => {
    expect(getPluginViewLabel(view({ displayName: "Weather", title: "Weather Panel" }), "en"))
      .toBe("Weather");
  });

  it("trims the displayName", () => {
    expect(getPluginViewLabel(view({ displayName: "  Weather  ", title: "Weather Panel" }), "en"))
      .toBe("Weather");
  });

  it("falls back to title when displayName is absent", () => {
    expect(getPluginViewLabel(view({ title: "Weather Panel" }), "en")).toBe("Weather Panel");
  });

  it("falls back to title when displayName is blank once trimmed", () => {
    // An all-whitespace label would render as an invisible sidebar entry.
    expect(getPluginViewLabel(view({ displayName: "   ", title: "Weather Panel" }), "en"))
      .toBe("Weather Panel");
    expect(getPluginViewLabel(view({ displayName: "", title: "Weather Panel" }), "en"))
      .toBe("Weather Panel");
  });

  it("falls back to the plugin id when title is empty too", () => {
    expect(getPluginViewLabel(view({ displayName: "  ", title: "" }), "en")).toBe("com.acme.weather");
    expect(getPluginViewLabel(view({ title: "" }, "com.acme.notes"), "en")).toBe("com.acme.notes");
  });

  it("keeps inner whitespace — only the ends are trimmed", () => {
    expect(getPluginViewLabel(view({ displayName: " My  Weather ", title: "x" }), "en"))
      .toBe("My  Weather");
  });
});

describe("getPluginViewLabel — locales", () => {
  // The shape of the reported bug: the entry's own fields are Korean.
  const meeting = view({
    displayName: "미팅",
    title: "회의 기록",
    locales: {
      en: { displayName: "Meeting" },
      "pt-br": { displayName: "Reunião (BR)" },
      pt: { displayName: "Reunião" },
    },
  }, "meeting");

  it("step 1: the exact UI tag wins", () => {
    expect(getPluginViewLabel(meeting, "pt-br")).toBe("Reunião (BR)");
    expect(getPluginViewLabel(meeting, "en")).toBe("Meeting");
  });

  it("normalizes the UI tag before matching (case, underscore)", () => {
    expect(getPluginViewLabel(meeting, "PT_BR")).toBe("Reunião (BR)");
    expect(getPluginViewLabel(meeting, " EN ")).toBe("Meeting");
    expect(normalizePluginLocaleTag(" Pt_BR ")).toBe("pt-br");
  });

  it("step 2: the base language answers a regional tag the map does not name", () => {
    expect(getPluginViewLabel(meeting, "pt-pt")).toBe("Reunião");
    expect(getPluginViewLabel(meeting, "en-gb")).toBe("Meeting");
  });

  it("step 3: the entry's own fields answer a language the map does not name", () => {
    expect(getPluginViewLabel(meeting, "ko")).toBe("미팅");
    expect(getPluginViewLabel(meeting, "fr")).toBe("미팅");
  });

  it("step 4: the plugin id answers when nothing else is present", () => {
    expect(getPluginViewLabel(view({ title: " ", locales: { en: { description: "d" } } }, "p1"), "en"))
      .toBe("p1");
  });

  it("a localized title beats an own displayName in another language", () => {
    // Without this an English UI would show the Korean short name even though
    // the plugin declared an English title.
    const item = view({ displayName: "미팅", title: "회의", locales: { en: { title: "Meeting Recorder" } } });
    expect(getPluginViewLabel(item, "en")).toBe("Meeting Recorder");
  });

  it("within one language, displayName is preferred over title", () => {
    const item = view({ title: "회의", locales: { en: { displayName: "Meeting", title: "Meeting Recorder" } } });
    expect(getPluginViewLabel(item, "en")).toBe("Meeting");
  });

  it("the exact tag's title beats the base language's displayName", () => {
    const item = view({ title: "x", locales: { "en-gb": { title: "Meeting (GB)" }, en: { displayName: "Meeting" } } });
    expect(getPluginViewLabel(item, "en-gb")).toBe("Meeting (GB)");
  });

  it("does not read inherited keys as locales", () => {
    const item = view({ title: "Own", locales: {} });
    expect(getPluginViewLabel(item, "constructor")).toBe("Own");
    expect(getPluginViewLabel(item, "__proto__")).toBe("Own");
  });
});

describe("getPluginViewTitle / getPluginViewDescription", () => {
  const item = view({
    title: "회의 기록",
    description: "회의를 기록합니다.",
    locales: { en: { title: "Meeting Recorder", description: "Records meetings." }, ja: { displayName: "会議" } },
  }).extension;

  it("resolve one field through the same chain", () => {
    expect(getPluginViewTitle(item, "en-us")).toBe("Meeting Recorder");
    expect(getPluginViewDescription(item, "en")).toBe("Records meetings.");
    expect(getPluginViewTitle(item, "ko")).toBe("회의 기록");
    // `ja` declares only a displayName, so the other fields fall through.
    expect(getPluginViewTitle(item, "ja")).toBe("회의 기록");
    expect(getPluginViewDescription(item, "ja")).toBe("회의를 기록합니다.");
  });

  it("description is undefined when none is declared", () => {
    expect(getPluginViewDescription(view({ title: "t" }).extension, "en")).toBeUndefined();
  });
});
