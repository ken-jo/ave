// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { SELECT_NATIVE_OPTION } from "../browser-select-script.js";

const selectOption = new Function(`return (${SELECT_NATIVE_OPTION})`)() as (this: HTMLSelectElement, value: string) => boolean;

describe("native option selection", () => {
  it.each(["<fieldset disabled><select>", "<select disabled>"])("refuses an effectively disabled control: %s", (opening) => {
    document.body.innerHTML = `${opening}<option value="a">A</option><option value="b">B</option></select></fieldset>`;
    const select = document.querySelector("select") as HTMLSelectElement;
    let events = 0;
    select.addEventListener("input", () => { events += 1; });
    select.addEventListener("change", () => { events += 1; });
    expect(selectOption.call(select, "b")).toBe(false);
    expect(select.value).toBe("a");
    expect(events).toBe(0);
  });
  it("keeps the first legend exception for a disabled fieldset", () => {
    document.body.innerHTML = '<fieldset disabled><legend><select><option value="a">A</option><option value="b">B</option></select></legend></fieldset>';
    const select = document.querySelector("select") as HTMLSelectElement;
    expect(selectOption.call(select, "b")).toBe(true);
    expect(select.value).toBe("b");
  });
});
