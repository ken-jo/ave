import { expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { matcherMemo, openLocalityDecision, withLocalityDecision } from "../local-path-io.js";

it("matcherMemo lives with its owner off Windows and with the decision on Windows", () => {
  const platform = process.platform;
  const owner = {};
  const other = {};
  try {
    setProcessPlatform("linux");
    withLocalityDecision(() => matcherMemo<number>(owner).set("fact", 1));
    expect(withLocalityDecision(() => matcherMemo<number>(owner).get("fact"))).toBe(1);
    expect(withLocalityDecision(() => matcherMemo<number>(other).has("fact"))).toBe(false);

    setProcessPlatform("win32");
    withLocalityDecision(() => {
      expect(matcherMemo<number>(owner).has("fact")).toBe(false);
      matcherMemo<number>(owner).set("fact", 2);
      expect(withLocalityDecision(() => matcherMemo<number>(owner).get("fact"))).toBe(2);
      expect(matcherMemo<number>(other).has("fact")).toBe(false);
    });
    expect(withLocalityDecision(() => matcherMemo<number>(owner).has("fact"))).toBe(false);
  } finally {
    setProcessPlatform(platform);
  }
});

it.skipIf(process.platform === "win32")("reuses an explicit POSIX locality decision after a top-level return", () => {
  const decision = openLocalityDecision();
  expect(withLocalityDecision(() => 1, decision)).toBe(1);
  expect(withLocalityDecision(() => 2, decision)).toBe(2);
});

it.skipIf(process.platform === "win32")("does not inspect a nested POSIX locality result for a then getter", () => {
  const then = vi.fn(() => undefined);
  const value = { get then() { return then(); } };
  expect(withLocalityDecision(() => {
    expect(withLocalityDecision(() => value)).toBe(value);
    return 1;
  })).toBe(1);
  expect(then).not.toHaveBeenCalled();
});
