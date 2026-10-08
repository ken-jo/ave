// @vitest-environment jsdom
import "../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { I18nProvider } from "../react.js";

describe("I18nProvider", () => {
  it("sets the document language to the active locale, installed locales included", () => {
    const noop = () => {};
    const { rerender } = render(<I18nProvider locale="en" setLocale={noop}>x</I18nProvider>);
    expect(document.documentElement.lang).toBe("en");
    rerender(<I18nProvider locale="fr" setLocale={noop}>x</I18nProvider>);
    expect(document.documentElement.lang).toBe("fr");
  });
});
