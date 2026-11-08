import "../../../../../test/renderer/setup.js";
import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { ThemeProvider, useTheme } from "../ThemeProvider.js";
import { DEFAULT_APPEARANCE } from "../../../../shared/appearance-settings.js";

function Probe() { return <span>{useTheme().scheme.id}</span>; }
afterEach(() => { delete window.__aveInitialAppearance; });
describe("saved appearance seed", () => {
  it("starts with the synchronous preload appearance", () => {
    window.__aveInitialAppearance = { ...DEFAULT_APPEARANCE, mode: "dark", darkScheme: "nord" };
    const view = render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(view.getByText("nord")).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-shell")).toBe("dark");
  });
  it("lets an explicit initial appearance select the preview", () => {
    window.__aveInitialAppearance = { ...DEFAULT_APPEARANCE, mode: "dark" };
    const view = render(<ThemeProvider initialAppearance={{ ...DEFAULT_APPEARANCE, mode: "light", lightScheme: "one-light" }}><Probe /></ThemeProvider>);
    expect(view.getByText("one-light")).toBeInTheDocument();
  });
});

it("projects the code font onto all mono consumers and restores a fallback", () => {
 const view = render(<ThemeProvider initialAppearance={{ ...DEFAULT_APPEARANCE, terminalFont: { ...DEFAULT_APPEARANCE.terminalFont, family: "Example Mono, monospace" } }}><Probe /></ThemeProvider>);
 expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe("Example Mono, monospace");
 view.unmount();
 render(<ThemeProvider initialAppearance={{ ...DEFAULT_APPEARANCE, terminalFont: { ...DEFAULT_APPEARANCE.terminalFont, family: "" } }}><Probe /></ThemeProvider>);
 expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(DEFAULT_APPEARANCE.terminalFont.family);
});

it.each(["Missing Mono", "'Odd, monospace, Name'", '"monospace"'])("adds a generic code fallback to %s", (family) => {
 render(<ThemeProvider initialAppearance={{ ...DEFAULT_APPEARANCE, terminalFont: { ...DEFAULT_APPEARANCE.terminalFont, family } }}><Probe /></ThemeProvider>);
 expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe(`${family}, monospace`);
});
