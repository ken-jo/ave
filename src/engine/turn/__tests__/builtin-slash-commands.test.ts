/**
 * BUILTIN_SLASH_COMMANDS is the routing list run-turn consults to decide
 * whether `/<name>` is a host command or a user's request to use a skill of
 * that name. It is a hand-maintained copy of `handleCommand`'s switch, so the
 * two can drift: a built-in added to the switch but not the list would be
 * shadowed by a same-named skill, and a name left in the list after its case
 * is removed would swallow that skill and answer "unknown command".
 *
 * The switch is read from source because "every handled case is listed" is
 * not observable by calling `handleCommand` — an unlisted case is simply never
 * reached through run-turn.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../commands.js";

function handledCommandCases(): string[] {
  const source = readFileSync(fileURLToPath(new URL("../commands.ts", import.meta.url)), "utf8");
  const start = source.indexOf("export async function handleCommand(");
  const end = source.indexOf("export async function handlePermissionCommand(");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  const switchStart = body.indexOf("switch (command) {");
  expect(switchStart).toBeGreaterThanOrEqual(0);
  const cases = [...body.slice(switchStart).matchAll(/^\s*case\s+"([^"]+)"\s*:/gm)].map((m) => m[1]);
  // A parse that found nothing would make the equality below vacuous.
  expect(cases.length).toBeGreaterThan(0);
  return cases;
}

describe("BUILTIN_SLASH_COMMANDS", () => {
  it("lists exactly the commands handleCommand's switch handles", () => {
    const handled = handledCommandCases();
    expect(new Set(handled).size).toBe(handled.length);
    expect([...BUILTIN_SLASH_COMMANDS].sort()).toEqual([...handled].sort());
  });
});
