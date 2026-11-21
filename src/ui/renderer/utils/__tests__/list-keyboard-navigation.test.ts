import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listNavigationTarget,
  mightProducePrintableCharacter,
  TYPE_NAVIGATION_RESET_MS,
  TypeNavigationController,
} from "../list-keyboard-navigation.js";

const key = (value: string, modifiers: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; isComposing: boolean }> = {}) =>
  ({ key: value, ctrlKey: false, metaKey: false, altKey: false, ...modifiers });

describe("listNavigationTarget", () => {
  it("moves one row, a page, or to either end, and stops at the ends", () => {
    expect(listNavigationTarget("ArrowDown", 0, 5, 3)).toBe(1);
    expect(listNavigationTarget("ArrowDown", 4, 5, 3)).toBe(4);
    expect(listNavigationTarget("ArrowUp", 0, 5, 3)).toBe(0);
    expect(listNavigationTarget("ArrowUp", 3, 5, 3)).toBe(2);
    expect(listNavigationTarget("Home", 3, 5, 3)).toBe(0);
    expect(listNavigationTarget("End", 1, 5, 3)).toBe(4);
    expect(listNavigationTarget("PageDown", 0, 10, 3)).toBe(3);
    expect(listNavigationTarget("PageDown", 8, 10, 3)).toBe(9);
    expect(listNavigationTarget("PageUp", 4, 10, 3)).toBe(1);
    expect(listNavigationTarget("PageUp", 1, 10, 0)).toBe(0);
  });

  it("leaves other keys and an empty list alone", () => {
    expect(listNavigationTarget("Enter", 0, 5, 3)).toBeNull();
    expect(listNavigationTarget("a", 0, 5, 3)).toBeNull();
    expect(listNavigationTarget("End", 0, 0, 3)).toBeNull();
  });
});

describe("mightProducePrintableCharacter", () => {
  it("admits single characters, and not space, named keys, chords or keys an input method is composing", () => {
    expect(["a", "Z", "7", ".", "-", "한"].map((value) => mightProducePrintableCharacter(key(value)))).toEqual([true, true, true, true, true, true]);
    expect([" ", "Enter", "ArrowDown", "F10", "Process"].map((value) => mightProducePrintableCharacter(key(value)))).toEqual([false, false, false, false, false]);
    expect(mightProducePrintableCharacter(key("a", { ctrlKey: true }))).toBe(false);
    expect(mightProducePrintableCharacter(key("a", { metaKey: true }))).toBe(false);
    expect(mightProducePrintableCharacter(key("a", { altKey: true }))).toBe(false);
    expect(mightProducePrintableCharacter(key("ㅎ", { isComposing: true }))).toBe(false);
  });
});

describe("TypeNavigationController", () => {
  const labels = ["assets", "docs", "data.csv", "README.md", "retry-policy.ts", undefined, "src"];
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("grows a word while typing and keeps the focused row while it still matches", () => {
    const typed = new TypeNavigationController();
    expect(typed.typing).toBe(false);
    // "d" from the first row finds "docs"; "da" no longer matches it and moves on to "data.csv".
    expect(typed.input("d", labels, 0)).toBe(1);
    expect(typed.typing).toBe(true);
    expect(typed.input("a", labels, 1)).toBe(2);
    expect(typed.input("t", labels, 2)).toBe(2);
  });

  it("walks through the rows that start with a letter when it is typed again as a new word, wrapping at the end", () => {
    const typed = new TypeNavigationController();
    expect(typed.input("d", labels, 0)).toBe(1);
    vi.advanceTimersByTime(TYPE_NAVIGATION_RESET_MS);
    expect(typed.typing).toBe(false);
    expect(typed.input("d", labels, 1)).toBe(2);
    vi.advanceTimersByTime(TYPE_NAVIGATION_RESET_MS);
    expect(typed.input("d", labels, 2)).toBe(1);
  });

  it("matches without regard to case, falls back to an unbroken run of two or more characters, and reports no match", () => {
    const typed = new TypeNavigationController();
    expect(typed.input("R", labels, 0)).toBe(3);
    vi.advanceTimersByTime(TYPE_NAVIGATION_RESET_MS);
    // No label starts with "po"; "retry-policy.ts" contains it. A single character never matches inside a label.
    expect(typed.input("p", labels, 0)).toBe(-1);
    expect(typed.input("o", labels, 0)).toBe(4);
    typed.clear();
    expect(typed.input("z", labels, 0)).toBe(-1);
  });

  it("keeps the word alive while keys keep coming and forgets it 800 ms after the last one", () => {
    const typed = new TypeNavigationController();
    typed.input("s", labels, 0);
    vi.advanceTimersByTime(TYPE_NAVIGATION_RESET_MS - 1);
    expect(typed.input("r", labels, 6)).toBe(6);
    vi.advanceTimersByTime(TYPE_NAVIGATION_RESET_MS - 1);
    expect(typed.typing).toBe(true);
    vi.advanceTimersByTime(1);
    expect(typed.typing).toBe(false);
  });
});
