/** Labels must preserve visible resource distinctions and stored order; write hostile characters as explicit escapes. */
import { describe, expect, it } from "vitest";
import { displaySafeLabel, hasControlChars, hasInvisibleOrReorderingChars, hasNonWhitespaceControlChars } from "../display-safe-text.js";

const cp = (value: number) => String.fromCodePoint(value);
const ZWSP = cp(0x200b);
const ZWNBSP = cp(0xfeff);
const WORD_JOINER = cp(0x2060);
const RLO = cp(0x202e);
const LRI = cp(0x2066);
const PDI = cp(0x2069);
describe("displaySafeLabel", () => {
  it("makes two names that render alike render differently", () => {
    // Strip invisible characters so spoofed names cannot masquerade as another resource.
    const spoof = `poli${ZWSP}cy.md`;
    expect(spoof).not.toBe("policy.md");
    expect(displaySafeLabel(spoof, 128)).toBe("policy.md");
    expect(displaySafeLabel(`poli${ZWNBSP}cy${WORD_JOINER}.md`, 128)).toBe("policy.md");
  });

  it("strips the bidi override that reverses a visible name", () => {
    // The classic filename trick: RLO makes `…gnp.exe` read as `…exe.png`.
    expect(displaySafeLabel(`report-${RLO}gnp.exe`, 128)).toBe("report-gnp.exe");
    expect(displaySafeLabel(`a${LRI}b${PDI}c`, 128)).toBe("abc");
  });

  it("removes controls that could forge a row or truncate one", () => {
    expect(displaySafeLabel("policy\u0000.md", 128)).toBe("policy.md");
    expect(displaySafeLabel("line\u001fbreak", 128)).toBe("linebreak");
    expect(displaySafeLabel("  annual   report .md  ", 128)).toBe("annual report .md");
    expect(displaySafeLabel("two\nlines", 128)).toBe("two lines");
  });

  it("bounds the label and reports nothing for nothing", () => {
    expect(displaySafeLabel("x".repeat(500), 64)).toHaveLength(64);
    // All-invisible names return empty so callers can show a visible URI fallback.
    expect(displaySafeLabel(ZWSP.repeat(4), 128)).toBe("");
    expect(displaySafeLabel(42, 128)).toBe("");
    expect(displaySafeLabel(undefined, 128)).toBe("");
  });

  // Sample default-ignorable families, including astral code points that require Unicode regex mode.
  it("removes the whole default-ignorable class, not a list of remembered characters", () => {
    const invisibles = [
      0x00ad, // soft hyphen
      0x034f, // combining grapheme joiner
      0x061c, // Arabic letter mark
      0x115f, // Hangul choseong filler
      0x1160, // Hangul jungseong filler
      0x17b4, // Khmer vowel inherent aq
      0x180b, // Mongolian free variation selector
      0x2065, // unassigned but default-ignorable
      0x3164, // Hangul filler
      0xfe00, // variation selector 1
      0xfe0f, // variation selector 16
      0xffa0, // halfwidth Hangul filler
      0xe0001, // language tag (astral)
      0xe0041, // tag latin capital A (astral)
    ];
    for (const codePoint of invisibles) {
      const spoof = `poli${String.fromCodePoint(codePoint)}cy.md`;
      // Assert distinct strings actually render identically before testing the spoof.
      expect(spoof, codePoint.toString(16)).not.toBe("policy.md");
      expect(displaySafeLabel(spoof, 128), codePoint.toString(16)).toBe("policy.md");
    }
  });

  it("leaves legitimate non-ASCII names alone", () => {
    // Preserve ordinary Hangul and CJK; unfamiliar characters are not inherently deceptive.
    expect(displaySafeLabel("정상-보고서.md", 128)).toBe("정상-보고서.md");
    expect(displaySafeLabel("年度報告.pdf", 128)).toBe("年度報告.pdf");
    expect(displaySafeLabel("café-résumé.txt", 128)).toBe("café-résumé.txt");
  });

  it("strips a variation selector, which is a deliberate cost", () => {
    // Display labels may lose emoji presentation; identifier validation rejects the invisible selector.
    const VS16 = String.fromCodePoint(0xfe0f);
    expect(displaySafeLabel(`⚠${VS16} alert.md`, 128)).toBe("⚠ alert.md");
  });
});

describe("hasControlChars / hasNonWhitespaceControlChars", () => {
  it("catches the C1 controls that only one of twelve hand-written copies had", () => {
    // C1 controls include line and ANSI terminators and must be checked alongside C0.
    expect(hasControlChars(`a${"\u001b"}b`)).toBe(true);
    expect(hasControlChars(`a${"\u009b"}b`)).toBe(true);
    expect(hasControlChars(`a${"\u0085"}b`)).toBe(true);
    expect(hasNonWhitespaceControlChars(`a${"\u009b"}b`)).toBe(true);
    expect(hasNonWhitespaceControlChars(`a${"\u0085"}b`)).toBe(true);
  });

  it("catches U+2028/U+2029, the line breaks a C0 range does not cover", () => {
    expect(hasControlChars(`a${"\u2028"}b`)).toBe(true);
    expect(hasControlChars(`a${"\u2029"}b`)).toBe(true);
    expect(hasNonWhitespaceControlChars(`a${"\u2028"}b`)).toBe(true);
  });

  it("splits on tab/newline/CR and nothing else", () => {
    for (const ws of ["\t", "\n", "\r"]) {
      expect(hasControlChars(`a${ws}b`)).toBe(true);
      expect(hasNonWhitespaceControlChars(`a${ws}b`)).toBe(false);
    }
    expect(hasControlChars("plain text")).toBe(false);
    expect(hasNonWhitespaceControlChars("plain text")).toBe(false);
  });

  it("leaves bidi, zero-width and variation selectors to the display class", () => {
    // Display cleanup deletes characters; validators must not reject whole emoji-bearing messages for the same class.
    expect(hasControlChars(`a${"\u202e"}b`)).toBe(false);
    expect(hasControlChars(`a${"\u200b"}b`)).toBe(false);
    expect(hasControlChars(`ok${"\ufe0f"}`)).toBe(false);
    expect(hasInvisibleOrReorderingChars(`a${"\u202e"}b`)).toBe(true);
    expect(hasInvisibleOrReorderingChars(`a${"\u200b"}b`)).toBe(true);
  });
});
