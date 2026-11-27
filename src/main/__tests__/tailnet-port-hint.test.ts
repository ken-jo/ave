import { describe, expect, it } from "vitest";
import { parseWindowsTailnetPortHint } from "../tailnet-port-hint.js";

// Excerpt of the localized IPv4 TCP exclusion table returned by the system utility.
const EXCLUDED_PORTS = [
  "",
  "프로토콜 tcp 포트 제외 범위",
  "",
  "시작 포트    끝 포트",
  "----------    --------",
  "      5113        5212",
  "      5357        5357",
  "     50000       50059     *",
  "",
  "* - 관리 포트 제외입니다.",
  "",
].join("\r\n");

describe("Windows Tailnet port hints", () => {
  it.each([5113, 5212, 5357, 50_059])("recognizes excluded port %i", port => {
    expect(parseWindowsTailnetPortHint(EXCLUDED_PORTS, port)).toBe("excluded-range");
  });

  it.each([44_620, 48_715])("identifies port %i within the mirrored range", port => {
    expect(parseWindowsTailnetPortHint(EXCLUDED_PORTS, port)).toBe("mirrored-range");
  });

  it("prefers a confirmed exclusion to the mirrored-range hint", () => {
    const output = EXCLUDED_PORTS.replace("      5357        5357", "     44620       48715");
    expect(parseWindowsTailnetPortHint(output, 46_200)).toBe("excluded-range");
  });

  it("recognizes an empty localized table", () => {
    const output = EXCLUDED_PORTS.replace(/^[ \t]*\d.*\r\n/gm, "");
    expect(parseWindowsTailnetPortHint(output, 46_200)).toBe("mirrored-range");
    expect(parseWindowsTailnetPortHint(output, 50_000)).toBeNull();
  });

  it.each([
    "----------    --------\r\n",
    EXCLUDED_PORTS.slice(0, EXCLUDED_PORTS.indexOf("      5113")),
    EXCLUDED_PORTS.slice(0, EXCLUDED_PORTS.indexOf("* - 관리 포트 제외입니다.")),
    EXCLUDED_PORTS.slice(0, EXCLUDED_PORTS.indexOf("* - 관") + "* - 관".length),
  ])("uses generic guidance for a truncated table (%j)", output => {
    expect(parseWindowsTailnetPortHint(output, 46_200)).toBeNull();
  });

  it("rejects an unterminated footer after a matching exclusion", () => {
    expect(parseWindowsTailnetPortHint(EXCLUDED_PORTS.trimEnd(), 5113)).toBeNull();
  });

  it.each([
    "     unreadable row",
    "     48715       44620",
    "     44620       99999",
    "     0           48715",
    "     44620       48715\r\n     unreadable row",
  ])("rejects a malformed body after the separator (%j)", body => {
    const output = ["시작 포트    끝 포트", "----------    --------", body, "* - 관리 포트 제외입니다.", ""].join("\r\n");
    expect(parseWindowsTailnetPortHint(output, 46_200)).toBeNull();
  });

  it("returns no hint for an unrelated port or unavailable table", () => {
    expect(parseWindowsTailnetPortHint(EXCLUDED_PORTS, 28_000)).toBeNull();
    expect(parseWindowsTailnetPortHint("The requested operation requires elevation.", 46_200)).toBeNull();
    expect(parseWindowsTailnetPortHint("", 46_200)).toBeNull();
  });
});
