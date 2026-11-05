import { describe, expect, it } from "vitest";
import { routineSummaryOf, stripRoutineSummary } from "../routine-summary.js";

describe("the routine summary block", () => {
  it("is the one block that ends the answer", () => {
    const text = "Done.\n\n<summary>build green</summary>\n";
    expect(routineSummaryOf(text)).toBe("build green");
    expect(stripRoutineSummary(text)).toBe("Done.");
  });

  it("leaves an HTML <details><summary> in the answer alone", () => {
    const text = "Notes:\n<details><summary>Logs</summary>\nline 1\n</details>\n\n<summary>two failures</summary>";
    expect(routineSummaryOf(text)).toBe("two failures");
    expect(stripRoutineSummary(text)).toBe("Notes:\n<details><summary>Logs</summary>\nline 1\n</details>");
    const onlyDetails = "Here:\n<details><summary>Logs</summary>";
    expect(routineSummaryOf(onlyDetails)).toBeNull();
    expect(stripRoutineSummary(onlyDetails)).toBe(onlyDetails);
  });

  it("leaves <summary> inside a code fence alone", () => {
    const fenced = "Use this markup:\n```html\n<summary>Title</summary>\n```";
    expect(stripRoutineSummary(fenced)).toBe(fenced);
    const openFence = "Use this markup:\n```html\n<summary>Title</summary>";
    expect(routineSummaryOf(openFence)).toBeNull();
    expect(stripRoutineSummary(openFence)).toBe(openFence);
    const after = `${fenced}\n\n<summary>explained details markup</summary>`;
    expect(stripRoutineSummary(after)).toBe(fenced);
  });

  it("keeps a block that is not at the end, and strips one still streaming only for a partial answer", () => {
    const middle = "<summary>early</summary> then more text";
    expect(routineSummaryOf(middle)).toBeNull();
    expect(stripRoutineSummary(middle)).toBe(middle);
    expect(stripRoutineSummary("Done.\n<summary>bui", { partial: true })).toBe("Done.");
    expect(stripRoutineSummary("Done.\n<summary>bui")).toBe("Done.\n<summary>bui");
  });
});
