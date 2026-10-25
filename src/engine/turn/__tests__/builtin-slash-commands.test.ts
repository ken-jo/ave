// Source-read host command cases must match routing names or same-named skills can be shadowed.
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
