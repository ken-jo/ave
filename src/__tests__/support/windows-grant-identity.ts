import { expect, vi } from "vitest";
import { stripExtendedPathPrefix } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import * as facts from "../../shared/windows-path-facts.js";

/** Observe the real native pins, including both parts of the resolved object's identity. */
export function observeWindowsGrantIdentity(target: string) {
  const identity = facts.pinWindowsPaths([target])[0]!;
  expect(identity.exists).toBe(true);
  const pins = vi.spyOn(facts, "pinWindowsPaths");
  return {
    canonical: stripExtendedPathPrefix(identity.canonical!),
    assertPinned() {
      const matches = pins.mock.results.flatMap(result => result.type === "return" ? result.value : [])
        .flatMap(row => [...row.ancestors, row])
        .filter(row => row.canonical !== null && stripExtendedPathPrefix(row.canonical) === stripExtendedPathPrefix(identity.canonical!));
      expect(matches.length).toBeGreaterThan(0);
      for (const row of matches) expect(facts.windowsObjectKey(row)).toBe(facts.windowsObjectKey(identity));
    },
  };
}
