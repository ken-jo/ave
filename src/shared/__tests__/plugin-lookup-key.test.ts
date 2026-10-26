import { describe, it, expect } from "vitest";
import { normalizePluginLookupKey } from "../plugin-lookup-key.js";

describe("normalizePluginLookupKey", () => {
  it("returns the empty key for nullish or blank input", () => {
    expect(normalizePluginLookupKey(undefined)).toBe("");
    expect(normalizePluginLookupKey(null)).toBe("");
    expect(normalizePluginLookupKey("   ")).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizePluginLookupKey("  weather  ")).toBe("weather");
  });

  it("lowercases", () => {
    expect(normalizePluginLookupKey("Weather")).toBe("weather");
    expect(normalizePluginLookupKey("WEATHER")).toBe("weather");
  });

  it("drops an @scope/ prefix", () => {
    expect(normalizePluginLookupKey("@ave/weather")).toBe("weather");
    expect(normalizePluginLookupKey("@acme-corp/weather")).toBe("weather");
  });

  it("drops a trailing @version", () => {
    expect(normalizePluginLookupKey("weather@1.2.3")).toBe("weather");
    expect(normalizePluginLookupKey("@ave/weather@1.2.3")).toBe("weather");
  });

  it("drops the ave-plugin- package prefix", () => {
    expect(normalizePluginLookupKey("ave-plugin-samplewidget")).toBe("samplewidget");
    expect(normalizePluginLookupKey("@ave/ave-plugin-samplewidget@0.1.0")).toBe("samplewidget");
  });

  it("drops the plugin- package prefix", () => {
    expect(normalizePluginLookupKey("plugin-weather")).toBe("weather");
  });

  it("collapses every run of non-alphanumerics to a single dash", () => {
    expect(normalizePluginLookupKey("my_weather.tool")).toBe("my-weather-tool");
    expect(normalizePluginLookupKey("My  Weather  Tool")).toBe("my-weather-tool");
  });

  it("trims leading and trailing dashes", () => {
    expect(normalizePluginLookupKey("--weather--")).toBe("weather");
    expect(normalizePluginLookupKey("!weather!")).toBe("weather");
  });

  it("maps the spellings one plugin is known by to one key", () => {
    const spellings = [
      "weather",
      "Weather",
      "@ave/plugin-weather@0.1.0",
      "plugin-weather",
      " weather ",
    ];
    expect(new Set(spellings.map(normalizePluginLookupKey))).toEqual(new Set(["weather"]));
  });

  it("keeps distinct plugins distinct", () => {
    expect(normalizePluginLookupKey("weather")).not.toBe(normalizePluginLookupKey("weather-pro"));
    expect(normalizePluginLookupKey("git")).not.toBe(normalizePluginLookupKey("github"));
  });
});
