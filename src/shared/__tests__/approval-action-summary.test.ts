import { afterEach, describe, expect, it } from "vitest";
import { approvalActionSummary } from "../approval-action-summary.js";
import { setLocale, t } from "../../i18n/runtime.js";

afterEach(() => setLocale("ko"));

describe("approvalActionSummary", () => {
  it.each(["ko", "en"] as const)("describes an outside write in the bounded notification action in %s", (locale) => {
    setLocale(locale);
    const action = approvalActionSummary({
      toolName: "write_file", toolCategory: "write", kind: "out-of-allowed-dir", args: {},
      outOfAllowedDir: { candidatePath: "/workspace/" + "x".repeat(100) },
    }, t, { maxCharacters: 30 });
    expect([...action]).toHaveLength(30);
    expect(action).toMatch(locale === "ko" ? /^허용 범위 밖의 x+… 쓰기$/ : /^Write x+… outside scope$/);
  });
  it.each(["ko", "en"] as const)("bounds only a long target while keeping the write action in %s", (locale) => {
    setLocale(locale);
    const request = { toolName: "write_file", args: { path: "x".repeat(100) } };
    const bounded = approvalActionSummary(request, t, { maxCharacters: 30 });
    expect([...bounded]).toHaveLength(30);
    expect(bounded).toMatch(locale === "ko" ? /^x+… 파일 쓰기$/ : /^Write x+… file$/);
    expect(approvalActionSummary(request, t)).toContain("x".repeat(100));
  });

  it.each(["ko", "en"] as const)("keeps outside-scope meaning in the bounded action in %s", (locale) => {
    setLocale(locale);
    const action = approvalActionSummary({
      toolName: "read_file", toolCategory: "read", kind: "out-of-allowed-dir", args: {},
      outOfAllowedDir: { candidatePath: "/workspace/" + "x".repeat(100) },
    }, t, { maxCharacters: 30 });
    expect([...action]).toHaveLength(30);
    expect(action).toMatch(locale === "ko" ? /^허용 범위 밖의 x+… 읽기$/ : /^Read x+… outside scope$/);
  });
});
