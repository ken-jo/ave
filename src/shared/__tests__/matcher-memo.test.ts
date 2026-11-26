import { expect, it } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { matcherMemo, withLocalityDecision } from "../local-path-io.js";

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
